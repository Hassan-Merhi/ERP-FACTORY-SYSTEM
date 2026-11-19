// ── Golden Coast Phase 5: production POS sale posting ────────────────────────
//
// Phase 4 retired the legacy Supplier Partner `/api/sp/sales` mutation and the
// Phase 1 `location_sale` posting for Golden Coast companies. This module is
// their post-cutover replacement: it consumes the canonical Phase 4 FIFO lots,
// derives COGS from the units actually consumed, and posts Sales and COGS
// through the existing central posting engine inside one transaction that also
// owns the inventory movement.
//
// Non-Golden-Coast Supplier Partner companies never reach this handler: the
// readiness guard rejects them and their existing `/api/sp/sales` flow is left
// exactly as it was.

import type { Express, Request, Response } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { spStockMovements } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import { PostingValidationError, postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import { GOLDEN_COAST_CUTOVER_DATE } from "../../services/accounting/goldenCoastCutoverFifo";
import {
  GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES,
  GoldenCoastPhase5SaleError,
  buildGoldenCoastPhase5SalePostings,
  goldenCoastPhase5SaleDigest,
  parseGoldenCoastPhase5SaleInput,
  planGoldenCoastPhase5Sale,
  type GoldenCoastPhase5PostingRole,
  type GoldenCoastPhase5SaleInput,
} from "../../services/accounting/goldenCoastPosSale";
import { adjustSpInventoryAtomic, respondToSpInventoryIntegrityError } from "../../services/sp/spInventoryIntegrity";
import { isGoldenCoastCompany } from "./spGoldenCoastCutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import { getCurrentExchangeRate } from "../helpers/exchangeRateHelpers";
import {
  GoldenCoastPhase5RouteError,
  PHASE5_MAX_SALE_LINES,
  assertCompanyLocation,
  assertPhase4BridgePosted,
  phase5RequestBudget,
  postingDependencies,
  resolvePhase5Accounts,
  type DatabaseTransaction,
  type PersistedPostingResult,
} from "./spGoldenCoastPosSalePostingRoutesActiveSubTypeAccount";
import {
  findReplayedSale,
  lockFifoLots,
  resolveSaleSideAccount,
} from "./spGoldenCoastPosSalePostingRoutesResolveSaleSideAccount";

async function consumeFifoLot(
  tx: DatabaseTransaction,
  companyId: number,
  allocation: { lotId: number; qty: string; qtyRemainingAfter: string }
): Promise<void> {
  const updated = await tx.execute(sql`
    UPDATE sp_stock_movements
    SET qty_remaining = ${allocation.qtyRemainingAfter}
    WHERE id = ${allocation.lotId}
      AND company_id = ${companyId}
      AND CAST(qty_remaining AS numeric) >= CAST(${allocation.qty} AS numeric)
    RETURNING id
  `);
  if (resultRows(updated).length !== 1) {
    throw new GoldenCoastPhase5RouteError(
      `Golden Coast FIFO lot #${allocation.lotId} changed while the sale was being posted`,
      "GC_PHASE5_FIFO_CONFLICT",
      409
    );
  }
}

async function handleReadiness(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_PHASE5_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }

    const blockers: string[] = [];
    let accounts: Awaited<ReturnType<typeof resolvePhase5Accounts>> | null = null;
    let cutoverLotCount = 0;
    try {
      accounts = await resolvePhase5Accounts(db, companyId);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    try {
      cutoverLotCount = await assertPhase4BridgePosted(db, companyId);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }

    const available = await db
      .select({
        locationId: spStockMovements.locationId,
        stockItemId: spStockMovements.stockItemId,
        articleCode: spStockMovements.articleCode,
        qtyAvailable: sql<string>`COALESCE(SUM(CAST(${spStockMovements.qtyRemaining} AS numeric)), 0)::text`,
      })
      .from(spStockMovements)
      .where(
        and(
          eq(spStockMovements.companyId, companyId),
          inArray(spStockMovements.sourceType, [...GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES]),
          sql`CAST(${spStockMovements.qtyRemaining} AS numeric) > 0`
        )
      )
      .groupBy(spStockMovements.locationId, spStockMovements.stockItemId, spStockMovements.articleCode)
      .orderBy(asc(spStockMovements.locationId), asc(spStockMovements.stockItemId));

    res.json({
      cutoverDate: GOLDEN_COAST_CUTOVER_DATE,
      cutoverLotCount,
      accounts,
      availableStock: available,
      blockers,
      canPost: blockers.length === 0,
    });
  } catch (error) {
    logger.error("Golden Coast Phase 5 readiness failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handlePostSale(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let companyId: number | null = null;
  const userId = req.session.userId;

  try {
    companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const selectedCompany = companyId;

    if (!(await isGoldenCoastCompany(db, selectedCompany))) {
      res.status(409).json({
        code: "GC_PHASE5_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }

    const sale: GoldenCoastPhase5SaleInput = parseGoldenCoastPhase5SaleInput({
      companyId: selectedCompany,
      body: req.body,
      maxLines: PHASE5_MAX_SALE_LINES,
    });
    const exchangeRate = await getCurrentExchangeRate(selectedCompany);

    const result = await db.transaction(async (tx) => {
      // Serializes two concurrent submissions of the same sale so replay
      // detection, FIFO consumption and both postings observe one state.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase5-sale:${selectedCompany}:${sale.clientRequestId}`}))`
      );

      if (!(await isGoldenCoastCompany(tx, selectedCompany))) {
        throw new GoldenCoastPhase5RouteError(
          "Golden Coast account setup is not configured",
          "GC_PHASE5_NOT_CONFIGURED",
          409
        );
      }

      await assertPhase4BridgePosted(tx, selectedCompany);
      await assertCompanyLocation(tx, selectedCompany, sale.locationId);
      const accounts = await resolvePhase5Accounts(tx, selectedCompany);
      const saleSideAccount = await resolveSaleSideAccount(
        tx,
        selectedCompany,
        (req.body as Record<string, unknown> | undefined)?.saleSideAccount,
        accounts.saleSideAccountId
      );

      // Resolved before replay detection because the settlement account is part
      // of what makes two submissions the same sale.
      const saleDigest = goldenCoastPhase5SaleDigest({ sale, saleSideAccount });
      const replayed = await findReplayedSale(tx, selectedCompany, sale.clientRequestId, saleDigest);
      if (replayed) return { replayed: true as const, postings: replayed, plan: null };

      const stockItemIds = [...new Set(sale.lines.map((line) => line.stockItemId))];
      const lots = await lockFifoLots(tx, selectedCompany, sale.locationId, stockItemIds);
      const plan = planGoldenCoastPhase5Sale({ sale, lots });

      for (const allocation of plan.allocations) {
        await consumeFifoLot(tx, selectedCompany, allocation);
        await adjustSpInventoryAtomic(tx, {
          companyId: selectedCompany,
          locationId: allocation.locationId,
          stockItemId: allocation.stockItemId,
          deltaQty: -Number(allocation.qty),
          context: `Golden Coast Phase 5 sale ${sale.clientRequestId} from FIFO lot #${allocation.lotId}`,
          sourceVoucherType: "GC_PHASE5_SALE",
        });
      }

      const batch = buildGoldenCoastPhase5SalePostings({
        plan,
        accounts,
        saleSideAccount,
        saleDigest,
        exchangeRate: exchangeRate != null ? String(exchangeRate) : null,
        actor: {
          userId: userId ?? null,
          username: req.session.username || "unknown",
          reason: "Golden Coast Phase 5 POS sale",
        },
      });

      const postings: Array<{
        role: GoldenCoastPhase5PostingRole;
        voucher: PersistedPostingResult["voucher"];
        entries: PersistedPostingResult["entries"];
      }> = [];
      for (const item of batch.postings) {
        const posted = (await postBalancedVoucherTx(tx, item.request, postingDependencies)) as PersistedPostingResult;
        if (posted.replayed) {
          // Replay detection above found no markers, so a replay here means the
          // idempotency state moved underneath this transaction.
          throw new GoldenCoastPhase5RouteError(
            `Golden Coast sale ${sale.clientRequestId} ${item.role} voucher was already posted`,
            "GC_PHASE5_IDEMPOTENCY_INCONSISTENT",
            409
          );
        }
        postings.push({ role: item.role, voucher: posted.voucher, entries: posted.entries });
      }

      return { replayed: false as const, postings, plan };
    });

    logger.info("Golden Coast Phase 5 POS sale posted", {
      module: "golden-coast-phase5",
      companyId: selectedCompany,
      userId,
      clientRequestId: sale.clientRequestId,
      locationId: sale.locationId,
      replayed: result.replayed,
      voucherIds: result.postings.map((item) => item.voucher.id),
      durationMs: Date.now() - startedAt,
    });

    res.json({
      clientRequestId: sale.clientRequestId,
      locationId: sale.locationId,
      replayed: result.replayed,
      revenueUsd: result.plan?.revenueUsd ?? null,
      cogsUsd: result.plan?.cogsUsd ?? null,
      grossProfitUsd: result.plan?.grossProfitUsd ?? null,
      lines: result.plan?.lines ?? null,
      allocations: result.plan?.allocations ?? null,
      postings: result.postings.map((item) => ({
        role: item.role,
        voucher: item.voucher,
        entries: item.entries,
      })),
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 5 POS sale failed", {
      module: "golden-coast-phase5",
      companyId,
      userId,
      durationMs: Date.now() - startedAt,
      error,
    });

    if (error instanceof GoldenCoastPhase5RouteError) {
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof GoldenCoastPhase5SaleError) {
      const status = error.code === "GC_PHASE5_INPUT_INVALID" ? 400 : 409;
      res.status(status).json({ code: error.code, message: error.message });
      return;
    }
    if (respondToSpInventoryIntegrityError(res, error)) return;
    if (error instanceof PostingValidationError) {
      res.status(error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400).json({
        code: error.code,
        message: error.message,
      });
      return;
    }
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerSpGoldenCoastPhase5PosSaleRoutes(app: Express): void {
  app.get(
    "/api/sp/golden-coast/phase5/pos-sale/readiness",
    privilegedReadRateLimit,
    requireAuth,
    (req, res) => void handleReadiness(req, res)
  );
  // Company scope, Supplier Partner permission (`sp_sales_create`) and audit
  // logging are enforced by the SP access-control middleware mounted earlier.
  app.post(
    "/api/sp/golden-coast/phase5/pos-sale",
    privilegedMutationRateLimit,
    phase5RequestBudget,
    requireAuth,
    (req, res) => void handlePostSale(req, res)
  );
}
