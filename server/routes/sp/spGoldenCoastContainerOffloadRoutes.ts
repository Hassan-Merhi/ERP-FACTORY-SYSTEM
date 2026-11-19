import type { Express, Request, Response } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import { spContainerLines, spContainers, spOffloadCharges, spOffloads, spStockMovements } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import { postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import {
  GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE,
  GOLDEN_COAST_PHASE8_SOURCE_TYPE,
  buildGoldenCoastPhase8OffloadPosting,
  parseGoldenCoastPhase8OffloadInput,
  planGoldenCoastPhase8Offload,
} from "../../services/accounting/goldenCoastContainerOffload";
import { adjustSpInventoryAtomic, respondToSpInventoryIntegrityError } from "../../services/sp/spInventoryIntegrity";
import { requireSpCompany } from "./spHelpers";
import {
  handleFreshStartExcelImport,
  type GoldenCoastPhase8FreshStartGuards,
} from "./spGoldenCoastFreshStartImportRoute";
import {
  GoldenCoastPhase8RouteError,
  actorFromRequest,
  postingDependencies,
  respondKnownError,
  type PersistedPostingResult,
} from "./spGoldenCoastRouteSupport";
import {
  PHASE8_MAX_CHARGES,
  assertPhase8Ready,
  phase8RequestBudget,
  resolveRoleAccounts,
  validateFundingAccount,
  validateLocation,
  validateStockItems,
} from "./spGoldenCoastContainerOffloadRoutesValidateFundingAccount";
import { handleReadiness, loadFundedContainer } from "./loadFundedContainer";
import { handleCreateContainer } from "./handleCreateContainer";

async function handleOffload(req: Request, res: Response): Promise<void> {
  let companyId: number | null = null;
  try {
    companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const selectedCompany = companyId;
    const offloadInput = parseGoldenCoastPhase8OffloadInput({
      companyId: selectedCompany,
      body: req.body,
      maxCharges: PHASE8_MAX_CHARGES,
    });
    const actor = actorFromRequest(req);

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase8:${selectedCompany}`}))`);
      await assertPhase8Ready(tx, selectedCompany);
      const accounts = await resolveRoleAccounts(tx, selectedCompany);
      await validateLocation(tx, selectedCompany, offloadInput.locationId);
      const funded = await loadFundedContainer(tx, selectedCompany, offloadInput.containerId, accounts);
      if (offloadInput.chargeFundingAccount) {
        if (funded.origin !== "cutover" && funded.origin !== "fresh_start_excel") {
          throw new GoldenCoastPhase8RouteError(
            "chargeFundingAccount only applies to a cutover container; a Phase 8 container pays its charges from the funded reserve",
            "GC_PHASE8_CHARGE_FUNDING_UNEXPECTED"
          );
        }
        await validateFundingAccount(tx, selectedCompany, offloadInput.chargeFundingAccount);
      }
      const plan = planGoldenCoastPhase8Offload({ offload: offloadInput, funded });
      const postingRequest = buildGoldenCoastPhase8OffloadPosting({
        offload: offloadInput,
        funded,
        plan,
        accounts,
        actor,
      });

      const [existingOffload] = await tx
        .select()
        .from(spOffloads)
        .where(and(eq(spOffloads.companyId, selectedCompany), eq(spOffloads.containerId, offloadInput.containerId)))
        .limit(1);
      if (existingOffload) {
        if (!existingOffload.voucherIdStock) {
          throw new GoldenCoastPhase8RouteError(
            "Existing offload has no Phase 8 voucher link",
            "GC_PHASE8_IDEMPOTENCY_CORRUPT",
            409
          );
        }
        const marker = await tx.execute(sql`
          SELECT source_id
          FROM accounting_posting_requests
          WHERE company_id = ${selectedCompany}
            AND voucher_id = ${existingOffload.voucherIdStock}
            AND source_type = ${GOLDEN_COAST_PHASE8_SOURCE_TYPE}
          LIMIT 2
        `);
        const markers = resultRows(marker);
        if (markers.length !== 1 || String(markers[0].source_id ?? "") !== postingRequest.source.sourceId) {
          throw new GoldenCoastPhase8RouteError(
            "Container is already offloaded under a different request or payload",
            "GC_PHASE8_IDEMPOTENCY_CONFLICT",
            409
          );
        }
        const movements = await tx
          .select()
          .from(spStockMovements)
          .where(
            and(eq(spStockMovements.companyId, selectedCompany), eq(spStockMovements.offloadId, existingOffload.id))
          )
          .orderBy(asc(spStockMovements.id));
        return { offload: existingOffload, movements, plan, replayed: true };
      }

      const posted = (await postBalancedVoucherTx(tx, postingRequest, postingDependencies)) as PersistedPostingResult;
      if (posted.replayed) {
        throw new GoldenCoastPhase8RouteError(
          "Phase 8 offload replay exists without its offload source document",
          "GC_PHASE8_IDEMPOTENCY_CORRUPT",
          409
        );
      }
      const [offload] = await tx
        .insert(spOffloads)
        .values({
          companyId: selectedCompany,
          containerId: offloadInput.containerId,
          offloadDate: offloadInput.offloadDate,
          totalQty: plan.totalQty,
          totalBaseCostUsd: plan.goodsCostUsd,
          totalLandedCostUsd: plan.actualChargesUsd,
          totalFinalCostUsd: plan.totalFinalCostUsd,
          voucherIdReversal: null,
          voucherIdStock: Number(posted.voucher.id),
        })
        .returning();
      if (offloadInput.charges.length > 0) {
        await tx.insert(spOffloadCharges).values(
          offloadInput.charges.map((charge) => ({
            offloadId: offload.id,
            companyId: selectedCompany,
            chargeType: charge.chargeType,
            description: charge.description,
            amountUsd: charge.amountUsd,
          }))
        );
      }

      const movementRows = [];
      const lineRows = await tx
        .select()
        .from(spContainerLines)
        .where(
          and(
            eq(spContainerLines.containerId, offloadInput.containerId),
            eq(spContainerLines.companyId, selectedCompany)
          )
        )
        .orderBy(asc(spContainerLines.id));
      const lineIdByStock = new Map(lineRows.map((line) => [Number(line.stockItemId), Number(line.id)]));
      for (const line of plan.lines) {
        const [movement] = await tx
          .insert(spStockMovements)
          .values({
            companyId: selectedCompany,
            containerId: offloadInput.containerId,
            offloadId: offload.id,
            containerLineId: lineIdByStock.get(line.stockItemId) ?? null,
            sourceType: GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE,
            articleCode: line.articleCode,
            description: line.description,
            stockItemId: line.stockItemId,
            locationId: offloadInput.locationId,
            qtyIn: line.qty,
            qtyRemaining: line.qty,
            baseUnitCostUsd: line.baseUnitCostUsd,
            landedUnitCostUsd: line.landedUnitCostUsd,
            finalUnitCostUsd: line.finalUnitCostUsd,
          })
          .returning();
        movementRows.push(movement);
        await adjustSpInventoryAtomic(tx, {
          companyId: selectedCompany,
          locationId: offloadInput.locationId,
          stockItemId: line.stockItemId,
          deltaQty: Number(line.qty),
          incomingRate: Number(line.finalUnitCostUsd),
          context: `Golden Coast Phase 8 offload #${offload.id}`,
          sourceVoucherType: GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE,
          sourceVoucherId: Number(posted.voucher.id),
        });
      }
      await tx
        .update(spContainers)
        .set({ status: "offloaded" })
        .where(and(eq(spContainers.id, offloadInput.containerId), eq(spContainers.companyId, selectedCompany)));
      return { offload, movements: movementRows, posting: posted, plan, replayed: false };
    });
    res.json(result);
  } catch (error) {
    if (respondToSpInventoryIntegrityError(res, error)) return;
    if (respondKnownError(res, error)) return;
    logger.error("Golden Coast Phase 8 offload failed", { companyId, error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

const freshStartGuards: GoldenCoastPhase8FreshStartGuards = {
  assertPhase8Ready,
  resolveRoleAccounts,
  validateStockItems,
};

export function registerSpGoldenCoastPhase8ContainerOffloadRoutes(app: Express): void {
  app.get(
    "/api/sp/golden-coast/phase8/container-offload/readiness",
    privilegedReadRateLimit,
    requireAuth,
    (req, res) => void handleReadiness(req, res)
  );
  app.post(
    "/api/sp/golden-coast/phase8/containers",
    privilegedMutationRateLimit,
    phase8RequestBudget,
    requireAuth,
    (req, res) => void handleCreateContainer(req, res)
  );
  app.post(
    "/api/sp/golden-coast/phase8/containers/import-excel",
    privilegedMutationRateLimit,
    phase8RequestBudget,
    requireAuth,
    (req, res) => void handleFreshStartExcelImport(req, res, freshStartGuards)
  );
  app.post(
    "/api/sp/golden-coast/phase8/offload",
    privilegedMutationRateLimit,
    phase8RequestBudget,
    requireAuth,
    (req, res) => void handleOffload(req, res)
  );
}
