import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import { requireAuth, requireNonPOS } from "../auth";
import { sql } from "drizzle-orm";
import { parseId } from "../lib/parseId";
import { MoneyDecimal, toMoney } from "../lib/money";
import { registerTransporterStatementRoutesPart1 } from "./registerTransporterStatementRoutesPart1";
import { registerTransporterStatementRoutesPart3 } from "./registerTransporterStatementRoutesPart3";

// ── route registration ────────────────────────────────────────────────────────

export function registerTransporterStatementRoutes(app: Express) {
  registerTransporterStatementRoutesPart1(app);
  registerTransporterStatementRoutesPart2(app);
}

function registerTransporterStatementRoutesPart2(app: Express) {
  // POST /api/transporter-statement/:accountId/reallocate
  // FIFO allocation: clears existing allocations for account and re-runs
  app.post("/api/transporter-statement/:accountId/reallocate", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accountId = parseId(req.params.accountId);
      if (accountId === null) return res.status(400).json({ message: "Invalid account ID" });

      // Verify account belongs to this company
      const accRows = await db.execute(
        sql`SELECT id FROM ledger_accounts WHERE id = ${accountId} AND company_id = ${companyId} LIMIT 1`
      );
      if (!accRows.rows?.length) return res.status(404).json({ message: "Account not found" });

      // Fetch all entries for this account ordered by date
      const entryRows = await db.execute(sql`
        SELECT
          ve.id,
          ve.debit_amount,
          ve.credit_amount,
          v.voucher_date
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_account_id = ${accountId}
          AND v.company_id = ${companyId}
          AND (v.deleted_at IS NULL)
          AND (v.optional IS DISTINCT FROM true)
        ORDER BY v.voucher_date ASC, ve.id ASC
      `);

      const entries = entryRows.rows as Array<{
        id: number;
        debit_amount: string;
        credit_amount: string;
        voucher_date: string;
      }>;

      // Separate credits (charges) and debits (payments)
      const creditEntries = entries
        .filter((e) => toMoney(e.credit_amount).gt(0))
        .map((e) => ({ id: e.id, remaining: toMoney(e.credit_amount) }));

      const debitEntries = entries
        .filter((e) => toMoney(e.debit_amount).gt(0))
        .map((e) => ({ id: e.id, remaining: toMoney(e.debit_amount) }));

      // Clear existing allocations for this account
      await db.execute(
        sql`DELETE FROM transporter_payment_allocations WHERE company_id = ${companyId}
            AND (credit_entry_id = ANY(${sql`ARRAY[${sql.join(
              creditEntries.map((c) => sql`${c.id}`),
              sql`, `
            )}]::integer[]`})
              OR debit_entry_id = ANY(${sql`ARRAY[${sql.join(
                debitEntries.map((d) => sql`${d.id}`),
                sql`, `
              )}]::integer[]`}))`
      );

      // FIFO: iterate debits in date order, distribute against oldest unpaid credits
      const newAllocations: Array<{ debitId: number; creditId: number; amount: string }> = [];

      for (const debit of debitEntries) {
        let debitRemaining = debit.remaining;
        for (const credit of creditEntries) {
          if (debitRemaining.lte(0)) break;
          if (credit.remaining.lte(0)) continue;

          const alloc = MoneyDecimal.min(debitRemaining, credit.remaining);
          newAllocations.push({ debitId: debit.id, creditId: credit.id, amount: alloc.toString() });
          debitRemaining = debitRemaining.minus(alloc);
          credit.remaining = credit.remaining.minus(alloc);
        }
      }

      // Insert new allocations in bulk
      if (newAllocations.length > 0) {
        for (const a of newAllocations) {
          await db.execute(
            sql`INSERT INTO transporter_payment_allocations
                  (company_id, debit_entry_id, credit_entry_id, allocated_amount)
                VALUES (${companyId}, ${a.debitId}, ${a.creditId}, ${a.amount})`
          );
        }
      }

      res.json({ ok: true, allocationsCreated: newAllocations.length });
    } catch (err: unknown) {
      logger.error("[TransporterStatement/reallocate]", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  registerTransporterStatementRoutesPart3(app);
}
