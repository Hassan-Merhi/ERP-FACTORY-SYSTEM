/**
 * employeePosFinancialRoutes: FactoryFinancialSnapshot endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import {
  factoryRawStock,
  factoryMixBatches,
  factoryBales,
  ledgerAccounts,
  voucherEntries,
  factoryWorkers,
  vouchers,
  factoryWorkerAdvances,
} from "@shared/schema";
import { eq, and, or, sql, inArray, ne, isNull } from "drizzle-orm";

export function registerFactoryFinancialSnapshotRoutes(app: Express) {
  // ─────────────────────────────────────────────────────────────────────────
  // Factory Financial Snapshot  —  single-request aggregates for the snapshot page
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/api/factory/financial-snapshot", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

      // ── 1. Raw material value (remaining kg × cost per kg USD) ────────────
      const rawStockRows = await db
        .select({
          receivedKg: factoryRawStock.receivedKg,
          usedKg: factoryRawStock.usedKg,
          costPerKg: factoryRawStock.costPerKg,
          costPerKgUsd: factoryRawStock.costPerKgUsd,
        })
        .from(factoryRawStock)
        .where(eq(factoryRawStock.companyId, companyId));

      let rawMaterialValue = 0;
      for (const r of rawStockRows) {
        const remaining = parseFloat(r.receivedKg || "0") - parseFloat(r.usedKg || "0");
        const cost = parseFloat(r.costPerKgUsd || "0") || parseFloat(r.costPerKg || "0");
        rawMaterialValue += remaining * cost;
      }

      // ── 2. Mix batch value (non-finalized batches: not COMPLETED or CLOSED) ─
      const mixBatchRows = await db
        .select({
          totalWeightKg: factoryMixBatches.totalWeightKg,
          usedKg: factoryMixBatches.usedKg,
          costPerKg: factoryMixBatches.costPerKg,
          status: factoryMixBatches.status,
        })
        .from(factoryMixBatches)
        .where(
          and(
            eq(factoryMixBatches.companyId, companyId),
            ne(factoryMixBatches.status, "COMPLETED"),
            ne(factoryMixBatches.status, "CLOSED")
          )
        );

      let mixBatchValue = 0;
      for (const b of mixBatchRows) {
        const remaining = parseFloat(b.totalWeightKg || "0") - parseFloat(b.usedKg || "0");
        const cost = parseFloat(b.costPerKg || "0");
        if (remaining > 0) mixBatchValue += remaining * cost;
      }

      // ── 3. Bale stock weight — only physically-present bales ──────────────
      // IN_STOCK = available, RESERVED_FOR_ORDER = allocated to a pending order
      // but physically still in the warehouse. Excludes SOLD / DISPATCHED / etc.
      const baleAgg = await db
        .select({
          totalWeight: sql<string>`COALESCE(SUM(CAST(${factoryBales.weightKg} AS numeric)), 0)`,
          totalCount: sql<string>`COUNT(*)`,
          totalValue: sql<string>`COALESCE(SUM(CAST(${factoryBales.totalCost} AS numeric)), 0)`,
        })
        .from(factoryBales)
        .where(
          and(eq(factoryBales.companyId, companyId), inArray(factoryBales.status, ["IN_STOCK", "RESERVED_FOR_ORDER"]))
        );

      const baleWeightTotal = parseFloat(baleAgg[0]?.totalWeight || "0");
      const baleCount = parseInt(baleAgg[0]?.totalCount || "0");
      const baleValueTotal = parseFloat(baleAgg[0]?.totalValue || "0");

      // ── 4. Outstanding worker advances ────────────────────────────────────
      const advanceAgg = await db
        .select({
          total: sql<string>`COALESCE(SUM(CAST(${factoryWorkerAdvances.remainingBalance} AS numeric)), 0)`,
          count: sql<string>`COUNT(*)`,
        })
        .from(factoryWorkerAdvances)
        .where(and(eq(factoryWorkerAdvances.companyId, companyId), eq(factoryWorkerAdvances.fullyPaid, false)));

      const outstandingAdvances = parseFloat(advanceAgg[0]?.total || "0");
      const advanceCount = parseInt(advanceAgg[0]?.count || "0");

      // ── 5. Active worker count ────────────────────────────────────────────
      const workerAgg = await db
        .select({
          total: sql<string>`COUNT(*)`,
        })
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.companyId, companyId), eq(factoryWorkers.active, true)));
      const activeWorkerCount = parseInt(workerAgg[0]?.total || "0");

      // ── 6. Equity / Capital ledger accounts with balances ─────────────────
      const equityAccounts = await db
        .select({
          id: ledgerAccounts.id,
          name: ledgerAccounts.name,
          code: ledgerAccounts.code,
          accountType: ledgerAccounts.accountType,
          openingBalance: ledgerAccounts.openingBalance,
          openingBalanceSide: ledgerAccounts.openingBalanceSide,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            or(
              sql`LOWER(${ledgerAccounts.accountType}) IN ('equity', 'capital', 'owner equity', 'owners equity', 'share capital')`,
              sql`LOWER(${ledgerAccounts.name}) ILIKE '%capital%'`
            )
          )
        );

      // Get voucher entries for equity accounts
      let capitalTotal = 0;
      if (equityAccounts.length > 0) {
        const equityIds = equityAccounts.map((a) => a.id);
        const equityEntries = await db
          .select({
            ledgerAccountId: voucherEntries.ledgerAccountId,
            debit: sql<string>`SUM(CAST(${voucherEntries.debitAmount} AS numeric))`,
            credit: sql<string>`SUM(CAST(${voucherEntries.creditAmount} AS numeric))`,
          })
          .from(voucherEntries)
          .innerJoin(
            vouchers,
            and(
              eq(voucherEntries.voucherId, vouchers.id),
              eq(vouchers.companyId, companyId),
              isNull(vouchers.deletedAt),
              eq(vouchers.optional, false)
            )
          )
          .where(inArray(voucherEntries.ledgerAccountId, equityIds))
          .groupBy(voucherEntries.ledgerAccountId);

        const balMap = new Map<number, { debit: number; credit: number }>();
        for (const e of equityEntries) {
          if (e.ledgerAccountId === null) continue;
          balMap.set(e.ledgerAccountId, { debit: parseFloat(e.debit || "0"), credit: parseFloat(e.credit || "0") });
        }

        for (const acc of equityAccounts) {
          const opening = parseFloat(acc.openingBalance || "0");
          const openingSide = acc.openingBalanceSide === "Dr" ? 1 : acc.openingBalanceSide === "Cr" ? -1 : -1;
          const signedOpening = opening * openingSide;
          const bal = balMap.get(acc.id) || { debit: 0, credit: 0 };
          const net = signedOpening + bal.debit - bal.credit;
          capitalTotal += net;
        }
      }

      res.json({
        rawMaterialValue: round2(rawMaterialValue),
        mixBatchValue: round2(mixBatchValue),
        baleWeightTotal: round2(baleWeightTotal),
        baleCount,
        baleValueTotal: round2(baleValueTotal),
        outstandingAdvances: round2(outstandingAdvances),
        advanceCount,
        activeWorkerCount,
        capitalTotal: round2(capitalTotal),
        equityAccounts: equityAccounts.map((a) => ({
          id: a.id,
          name: a.name,
          code: a.code,
          accountType: a.accountType,
        })),
      });
    } catch (error: unknown) {
      logger.error("Factory financial-snapshot error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Factory Net Position  —  "What We Have" vs "What We Owe"
  // Same logic as ERP /api/stats/net-profit but uses factory supplier tables
  // ─────────────────────────────────────────────────────────────────────────
}
