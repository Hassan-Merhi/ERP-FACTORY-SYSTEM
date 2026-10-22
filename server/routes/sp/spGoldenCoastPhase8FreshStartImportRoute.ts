/**
 * Golden Coast Fresh Start Excel container import
 * (POST /api/sp/golden-coast/phase8/containers/import-excel).
 *
 * Registered by registerSpGoldenCoastPhase8ContainerOffloadRoutes in
 * spGoldenCoastPhase8ContainerOffloadRoutes.ts at the original position. The
 * Phase 8 readiness, role-account and stock-item guards stay in that module and
 * are passed in, so the import runs exactly the same checks as before.
 */
import type { Request, Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ledgerAccounts, spContainerLines, spContainers } from "@shared/schema";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { sumMoney, toMoney } from "../../lib/money";
import { postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import {
  buildGoldenCoastFreshStartExcelFundingPosting,
  parseGoldenCoastPhase8ContainerInput,
  type GoldenCoastPhase8RoleAccounts,
} from "../../services/accounting/goldenCoastPhase8ContainerOffload";
import type { DbLike } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import { FRESH_START_OTW_SOURCE_NAME } from "@shared/goldenCoastOtwSource";
import {
  GoldenCoastPhase8RouteError,
  PHASE8_MAX_LINES,
  actorFromRequest,
  postingDependencies,
  respondKnownError,
  type PersistedPostingResult,
} from "./spGoldenCoastPhase8RouteSupport";

export interface GoldenCoastPhase8FreshStartGuards {
  assertPhase8Ready(conn: DbLike, companyId: number): Promise<void>;
  resolveRoleAccounts(conn: DbLike, companyId: number): Promise<GoldenCoastPhase8RoleAccounts>;
  validateStockItems(conn: DbLike, companyId: number, ids: readonly number[]): Promise<void>;
}

/**
 * The ERP-style Excel preview posts Fresh Start stock through Golden Coast's
 * supported Phase 8 central-posting path, not retired POST /api/sp/containers.
 * Supplier links are deliberately NULL and the clearing is internal to GC.
 * This is a separate mode from cash-funded Phase 8 containers.
 */
export async function handleFreshStartExcelImport(
  req: Request,
  res: Response,
  guards: GoldenCoastPhase8FreshStartGuards
): Promise<void> {
  const { assertPhase8Ready, resolveRoleAccounts, validateStockItems } = guards;
  let companyId: number | null = null;
  try {
    companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const selectedCompany = companyId;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (raw.importSource !== "excel") {
      throw new GoldenCoastPhase8RouteError("This endpoint only accepts a parsed Excel container");
    }
    if (raw.supplierId != null && raw.supplierId !== "" && raw.supplierId !== 0) {
      throw new GoldenCoastPhase8RouteError("Fresh Start imports must not have a supplier account");
    }
    const idempotencyKey = req.get("X-Idempotency-Key") || "";
    const actor = actorFromRequest(req);

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase8:${selectedCompany}`}))`);
      await assertPhase8Ready(tx, selectedCompany);
      const accounts = await resolveRoleAccounts(tx, selectedCompany);
      const clearingRows = await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, selectedCompany),
            eq(ledgerAccounts.subType, "sp_otw_clearing"),
            eq(ledgerAccounts.active, true),
            isNull(ledgerAccounts.deletedAt)
          )
        )
        .limit(2);
      if (clearingRows.length !== 1) {
        throw new GoldenCoastPhase8RouteError(
          "Exactly one active GC Goods OTW Clearing account must be configured",
          "GC_PHASE8_ROLES_INVALID",
          409
        );
      }

      // Use Phase 8's stock-item scope, date, quantity, rate, source and
      // idempotency validation. Funding account is constructed by the SERVER.
      const containerInput = parseGoldenCoastPhase8ContainerInput({
        companyId: selectedCompany,
        maxLines: PHASE8_MAX_LINES,
        body: {
          clientRequestId: idempotencyKey,
          supplierId: null,
          supplierName: FRESH_START_OTW_SOURCE_NAME,
          containerNumber: raw.containerNumber,
          invoiceNumber: raw.invoiceNumber,
          invoiceDate: raw.invoiceDate,
          reserveUsd: "0",
          fundingAccount: { kind: "ledger", id: clearingRows[0].id },
          notes: raw.notes,
          lines: raw.lines,
        },
      });
      await validateStockItems(
        tx,
        selectedCompany,
        containerInput.lines.map((line) => line.stockItemId)
      );
      const netInvoice = toMoney(String(raw.invoiceTotalUsd ?? "0"));
      const pct = toMoney(String(raw.discountPct ?? "0"));
      if (pct.lessThan(0) || pct.greaterThan(100) || netInvoice.lessThanOrEqualTo(0)) {
        throw new GoldenCoastPhase8RouteError("Invalid invoice total or discount percentage");
      }
      const gross = sumMoney(containerInput.lines.map((line) => toMoney(line.qty).times(line.unitRateUsd)));
      const chargeFields = ["freightEstimateUsd", "surchargeUsd", "fumigationUsd", "documentChargesUsd"] as const;
      const fees = chargeFields.map((field) => toMoney(String(raw[field] ?? "0")));
      if (fees.some((fee) => fee.lessThan(0))) {
        throw new GoldenCoastPhase8RouteError("Invoice fees cannot be negative");
      }
      const expected = gross.minus(gross.times(pct).div(100)).plus(sumMoney(fees));
      const tolerance = toMoney("0.03")
        .plus(gross.times("0.0000005"))
        .plus(toMoney(containerInput.lines.length).times("0.005"));
      if (netInvoice.minus(expected).abs().greaterThan(tolerance)) {
        throw new GoldenCoastPhase8RouteError(
          "Invoice total does not reconcile with item rates, discount and charges",
          "GC_PHASE8_INVOICE_TOTAL_MISMATCH",
          409
        );
      }
      const existingByNumber = containerInput.containerNumber
        ? await tx
            .select({ id: spContainers.id, goodsOtwVoucherId: spContainers.goodsOtwVoucherId })
            .from(spContainers)
            .where(
              and(
                eq(spContainers.companyId, selectedCompany),
                sql`upper(trim(${spContainers.containerNumber})) = upper(${containerInput.containerNumber})`,
                sql`${spContainers.status} <> 'cancelled'`
              )
            )
            .limit(1)
        : [];

      const postingRequest = buildGoldenCoastFreshStartExcelFundingPosting({
        container: containerInput,
        invoiceTotalUsd: netInvoice.toDecimalPlaces(2).toFixed(2),
        otwClearingAccountId: clearingRows[0].id,
        stockOtwAccountId: accounts.stockOtwAccountId,
        actor,
      });
      const posted = (await postBalancedVoucherTx(tx, postingRequest, postingDependencies)) as PersistedPostingResult;
      const [existingSource] = await tx
        .select()
        .from(spContainers)
        .where(
          and(
            eq(spContainers.companyId, selectedCompany),
            eq(spContainers.goodsOtwVoucherId, Number(posted.voucher.id))
          )
        )
        .limit(1);
      if (existingSource) {
        const existingLines = await tx
          .select()
          .from(spContainerLines)
          .where(
            and(eq(spContainerLines.companyId, selectedCompany), eq(spContainerLines.containerId, existingSource.id))
          );
        return { container: existingSource, lines: existingLines, posting: posted, replayed: true };
      }
      if (posted.replayed) {
        throw new GoldenCoastPhase8RouteError(
          "Fresh Start funding replay exists without its container source document",
          "GC_PHASE8_IDEMPOTENCY_CORRUPT",
          409
        );
      }
      if (existingByNumber.length > 0) {
        throw new GoldenCoastPhase8RouteError(
          "Container already imported into this company",
          "GC_PHASE8_DUPLICATE_CONTAINER",
          409
        );
      }
      const [container] = await tx
        .insert(spContainers)
        .values({
          companyId: selectedCompany,
          supplierId: null,
          supplierName: FRESH_START_OTW_SOURCE_NAME,
          containerNumber: containerInput.containerNumber,
          invoiceNumber: containerInput.invoiceNumber,
          invoiceDate: containerInput.invoiceDate,
          invoiceTotalUsd: netInvoice.toDecimalPlaces(2).toFixed(2),
          discountPct: pct.toFixed(4),
          freightEstimateUsd: fees[0].toFixed(2),
          surchargeUsd: fees[1].toFixed(2),
          fumigationUsd: fees[2].toFixed(2),
          documentChargesUsd: fees[3].toFixed(2),
          status: "open",
          goodsOtwVoucherId: Number(posted.voucher.id),
          notes: containerInput.notes,
        })
        .returning();
      const lines = await tx
        .insert(spContainerLines)
        .values(
          containerInput.lines.map((line) => ({
            containerId: container.id,
            companyId: selectedCompany,
            stockItemId: line.stockItemId,
            articleCode: line.articleCode,
            description: line.description,
            qty: line.qty,
            unitRateUsd: line.unitRateUsd,
          }))
        )
        .returning();
      return { container, lines, posting: posted, replayed: false };
    });
    res.json(result);
  } catch (error) {
    if (respondKnownError(res, error)) return;
    logger.error("Golden Coast Fresh Start Excel import failed", { companyId, error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
