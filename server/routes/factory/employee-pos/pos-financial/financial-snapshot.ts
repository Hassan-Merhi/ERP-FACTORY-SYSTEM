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
import type Decimal from "decimal.js";
import { MoneyDecimal, signedOpeningBalance, sumMoney, toMoney } from "../../../../lib/money";

export function registerFactoryFinancialSnapshotRoutes(app: Express) {
  // ─────────────────────────────────────────────────────────────────────────
  // Factory Financial Snapshot  —  single-request aggregates for the snapshot page
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/api/factory/financial-snapshot", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Cents, rounded half away from zero as Postgres numeric rounds.
      const round2 = (n: Decimal) => n.toDecimalPlaces(2).toNumber();

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

      let rawMaterialValue = new MoneyDecimal(0);
      for (const r of rawStockRows) {
        const remaining = toMoney(r.receivedKg).minus(toMoney(r.usedKg));
        const costUsd = toMoney(r.costPerKgUsd);
        const cost = costUsd.isZero() ? toMoney(r.costPerKg) : costUsd;
        rawMaterialValue = rawMaterialValue.plus(remaining.times(cost));
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

      let mixBatchValue = new MoneyDecimal(0);
      for (const b of mixBatchRows) {
        const remaining = toMoney(b.totalWeightKg).minus(toMoney(b.usedKg));
        if (remaining.greaterThan(0)) mixBatchValue = mixBatchValue.plus(remaining.times(toMoney(b.costPerKg)));
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

      const baleWeightTotal = toMoney(baleAgg[0]?.totalWeight);
      const baleCount = parseInt(baleAgg[0]?.totalCount || "0");
      const baleValueTotal = toMoney(baleAgg[0]?.totalValue);

      // ── 4. Outstanding worker advances ────────────────────────────────────
      const advanceAgg = await db
        .select({
          total: sql<string>`COALESCE(SUM(CAST(${factoryWorkerAdvances.remainingBalance} AS numeric)), 0)`,
          count: sql<string>`COUNT(*)`,
        })
        .from(factoryWorkerAdvances)
        .where(and(eq(factoryWorkerAdvances.companyId, companyId), eq(factoryWorkerAdvances.fullyPaid, false)));

      const outstandingAdvances = toMoney(advanceAgg[0]?.total);
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
      let capitalTotal = new MoneyDecimal(0);
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

        const netMovement = new Map<number, Decimal>();
        for (const e of equityEntries) {
          if (e.ledgerAccountId === null) continue;
          netMovement.set(e.ledgerAccountId, toMoney(e.debit).minus(toMoney(e.credit)));
        }

        // Equity openings without a side count as credit balances.
        capitalTotal = sumMoney(
          equityAccounts.map((acc) =>
            signedOpeningBalance(acc.openingBalance, acc.openingBalanceSide === "Dr" ? "Dr" : "Cr").plus(
              netMovement.get(acc.id) ?? 0
            )
          )
        );
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
