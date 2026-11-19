// Extracted from ./spGoldenCoastContainerOffloadRoutes.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import { spContainerLines, spContainers } from "@shared/schema";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import {
  buildGoldenCoastPhase8FundingPosting,
  parseGoldenCoastPhase8ContainerInput,
  planGoldenCoastPhase8Funding,
} from "../../services/accounting/goldenCoastContainerOffload";
import { requireSpCompany } from "./spHelpers";
import {
  actorFromRequest,
  GoldenCoastPhase8RouteError,
  type PersistedPostingResult,
  PHASE8_MAX_LINES,
  postingDependencies,
  respondKnownError,
} from "./spGoldenCoastRouteSupport";
import {
  assertPhase8Ready,
  resolveRoleAccounts,
  validateFundingAccount,
  validateStockItems,
  validateSupplier,
} from "./spGoldenCoastContainerOffloadRoutesValidateFundingAccount";

export async function handleCreateContainer(req: Request, res: Response): Promise<void> {
  let companyId: number | null = null;
  try {
    companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const selectedCompany = companyId;
    const containerInput = parseGoldenCoastPhase8ContainerInput({
      companyId: selectedCompany,
      body: req.body,
      maxLines: PHASE8_MAX_LINES,
    });
    const plan = planGoldenCoastPhase8Funding(containerInput);
    const actor = actorFromRequest(req);

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase8:${selectedCompany}`}))`);
      await assertPhase8Ready(tx, selectedCompany);
      const accounts = await resolveRoleAccounts(tx, selectedCompany);
      await validateFundingAccount(tx, selectedCompany, containerInput.fundingAccount);
      await validateStockItems(
        tx,
        selectedCompany,
        containerInput.lines.map((line) => line.stockItemId)
      );
      await validateSupplier(tx, selectedCompany, containerInput.supplierId);

      const postingRequest = buildGoldenCoastPhase8FundingPosting({ container: containerInput, plan, accounts, actor });
      const posted = (await postBalancedVoucherTx(tx, postingRequest, postingDependencies)) as PersistedPostingResult;
      const [existing] = await tx
        .select()
        .from(spContainers)
        .where(
          and(
            eq(spContainers.companyId, selectedCompany),
            eq(spContainers.goodsOtwVoucherId, Number(posted.voucher.id))
          )
        )
        .limit(1);
      if (existing) {
        const lines = await tx
          .select()
          .from(spContainerLines)
          .where(and(eq(spContainerLines.containerId, existing.id), eq(spContainerLines.companyId, selectedCompany)))
          .orderBy(asc(spContainerLines.id));
        return { container: existing, lines, posting: posted, plan, replayed: true };
      }
      if (posted.replayed) {
        throw new GoldenCoastPhase8RouteError(
          "Phase 8 funding replay exists without its container source document",
          "GC_PHASE8_IDEMPOTENCY_CORRUPT",
          409
        );
      }

      const [container] = await tx
        .insert(spContainers)
        .values({
          companyId: selectedCompany,
          supplierId: containerInput.supplierId,
          supplierName: containerInput.supplierName,
          containerNumber: containerInput.containerNumber,
          invoiceNumber: containerInput.invoiceNumber,
          invoiceDate: containerInput.invoiceDate,
          invoiceTotalUsd: plan.goodsCostUsd,
          discountPct: "0",
          freightEstimateUsd: "0",
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
            articleCode: line.articleCode,
            description: line.description,
            qty: line.qty,
            unitRateUsd: line.unitRateUsd,
            stockItemId: line.stockItemId,
          }))
        )
        .returning();
      return { container, lines, posting: posted, plan, replayed: false };
    });
    res.json(result);
  } catch (error) {
    if (respondKnownError(res, error)) return;
    logger.error("Golden Coast Phase 8 container funding failed", { companyId, error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
