// Extracted from ./transporterStatementRoutes.ts
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db, type RawQueryRow } from "../db";
import { requireAuth, requireNonPOS } from "../auth";
import { ledgerAccounts, containers } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { parseId } from "../lib/parseId";
import { MoneyDecimal, sumMoney, toMoney } from "../lib/money";
import type Decimal from "decimal.js";
import {
  addDays,
  extractContainerNumber,
  type TransporterStatementRow,
} from "./registerTransporterStatementRoutesPart1";

export function registerTransporterStatementRoutesPart3(app: Express) {
  // GET /api/transporter-statement/:accountId/statement
  app.get("/api/transporter-statement/:accountId/statement", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accountId = parseId(req.params.accountId);
      if (accountId === null) return res.status(400).json({ message: "Invalid account ID" });

      const { dateFrom, dateTo } = req.query as { dateFrom?: string; dateTo?: string };

      // Verify account belongs to this company
      const [account] = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)))
        .limit(1);
      if (!account) return res.status(404).json({ message: "Account not found" });

      // Get payment terms setting
      const settingsRows = await db.execute(
        sql`SELECT payment_terms_days FROM transporter_payment_settings
            WHERE company_id = ${companyId} AND ledger_account_id = ${accountId} LIMIT 1`
      );
      const paymentTermsDays: number =
        (settingsRows.rows?.[0] as { payment_terms_days: number })?.payment_terms_days ?? 0;

      // Fetch all voucher entries for this account (all time for running balance)
      const rawEntries = await db.execute<RawQueryRow<TransporterStatementRow>>(sql`
        SELECT
          ve.id,
          ve.voucher_id,
          ve.debit_amount,
          ve.credit_amount,
          ve.narration,
          v.voucher_date,
          v.description       AS voucher_description,
          v.voucher_number,
          v.voucher_type,
          COALESCE(tedd.due_date, NULL) AS manual_due_date
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        LEFT JOIN transporter_entry_due_dates tedd ON tedd.voucher_entry_id = ve.id
        WHERE ve.ledger_account_id = ${accountId}
          AND v.company_id = ${companyId}
          AND (v.deleted_at IS NULL)
          AND (v.optional IS DISTINCT FROM true)
        ORDER BY v.voucher_date ASC, ve.id ASC
      `);

      // Fetch containers for this company (for number plate / offload date lookup)
      const allContainers = await db
        .select({
          containerNumber: containers.containerNumber,
          numberPlate: containers.numberPlate,
          offloadDate: containers.offloadDate,
        })
        .from(containers)
        .where(eq(containers.companyId, companyId));

      const containerMap = new Map<string, { numberPlate: string | null; offloadDate: string | null }>();
      for (const c of allContainers) {
        containerMap.set(c.containerNumber.toUpperCase(), {
          numberPlate: c.numberPlate ?? null,
          offloadDate: c.offloadDate ?? null,
        });
      }

      // Opening balance
      const ob = toMoney(account.openingBalance);
      const obSide = account.openingBalanceSide;
      let runningBalance: Decimal = obSide === "Dr" ? ob.neg() : ob;

      const allRows = rawEntries.rows;

      // ── FIFO allocation computed on-the-fly ──────────────────────────────────
      // In this transporter ledger:
      //   CREDIT entries = transport fee charges (what you owe the transporter)
      //   DEBIT  entries = payments you've made
      // We iterate payments in date order and apply them oldest-charge-first.
      // This gives us paidMap: creditEntryId → how much of that charge is covered.
      // debit_amount/credit_amount are nullable numeric columns, so each is
      // parsed once and the row is kept only when that parse yielded a positive
      // amount — the previous filter-then-reparse could not tell the compiler
      // the second parse was safe.
      const fifoRows = (column: "credit_amount" | "debit_amount") =>
        allRows.flatMap((r) => {
          const amount = toMoney(r[column]);
          if (!amount.gt(0)) return [];
          return [{ id: r.id, total: amount, remaining: amount }];
        });

      const fifoCharges = fifoRows("credit_amount");
      const fifoPayments = fifoRows("debit_amount");

      // Account for pre-system opening balance.
      // If the account has a Cr opening balance, the transporter is owed that amount
      // from before any voucher entries existed. Payments must cover that pre-system
      // balance first before being applied to tracked voucher charges.
      // If Dr, the transporter already owes us money → more of our payments are free
      // to cover voucher charges.
      const preSystemBalance = obSide === "Cr" ? ob : ob.neg(); // positive = we owe from before
      const totalVoucherPayments = sumMoney(fifoPayments.map((p) => p.total));
      let payPool = MoneyDecimal.max(0, totalVoucherPayments.minus(MoneyDecimal.max(0, preSystemBalance)));

      const paidMap = new Map<number, Decimal>(); // chargeEntryId → paidAmount
      for (const charge of fifoCharges) {
        if (payPool.lte(0)) break;
        const alloc = MoneyDecimal.min(payPool, charge.remaining);
        if (alloc.gt(0)) {
          paidMap.set(charge.id, (paidMap.get(charge.id) ?? new MoneyDecimal(0)).plus(alloc));
          payPool = payPool.minus(alloc);
          charge.remaining = charge.remaining.minus(alloc);
        }
      }

      // Build rows with running balance
      const statementRows = allRows.map((row) => {
        const debit = toMoney(row.debit_amount);
        const credit = toMoney(row.credit_amount);
        runningBalance = runningBalance.plus(credit).minus(debit);

        const containerNum = extractContainerNumber(row.voucher_description) || extractContainerNumber(row.narration);

        let numberPlate: string | null = null;
        let offloadDate: string | null = null;
        if (containerNum) {
          const c = containerMap.get(containerNum.toUpperCase());
          if (c) {
            numberPlate = c.numberPlate;
            offloadDate = c.offloadDate;
          }
        }

        let dateToBePaid: string | null = null;
        if (row.manual_due_date) {
          dateToBePaid = row.manual_due_date;
        } else if (offloadDate && paymentTermsDays > 0) {
          dateToBePaid = addDays(offloadDate, paymentTermsDays);
        }

        // Determine payment status for credit rows (transport fee charges)
        // paidMap keys are credit entry IDs; value = how much of that charge FIFO covered
        let status: "unpaid" | "partial" | "paid" | null = null;
        let paidAmount: string | null = null;
        if (credit.gt(0)) {
          const paid = paidMap.get(row.id) ?? new MoneyDecimal(0);
          paidAmount = paid.toFixed(2);
          if (paid.lte(0)) {
            status = "unpaid";
          } else if (paid.gte(credit.minus(0.005))) {
            status = "paid";
          } else {
            status = "partial";
          }
        }

        return {
          id: row.id,
          voucherId: row.voucher_id,
          voucherNumber: row.voucher_number,
          voucherType: row.voucher_type,
          date: row.voucher_date,
          description: row.voucher_description || row.narration || "",
          narration: row.narration || "",
          debit: debit.gt(0) ? debit.toFixed(2) : null,
          credit: credit.gt(0) ? credit.toFixed(2) : null,
          runningBalance: runningBalance.toFixed(2),
          numberPlate,
          offloadDate,
          dateToBePaid,
          hasManualDueDate: !!row.manual_due_date,
          containerNumber: containerNum,
          status,
          paidAmount,
        };
      });

      // Apply date filters AFTER computing running balance
      const filteredRows = statementRows.filter((r) => {
        if (dateFrom && r.date < dateFrom) return false;
        if (dateTo && r.date > dateTo) return false;
        return true;
      });

      // Opening balance for the filtered window
      const filteredOpeningBalance =
        filteredRows.length > 0
          ? (() => {
              const firstIdx = allRows.findIndex((r) => r.id === filteredRows[0].id);
              if (firstIdx === 0) {
                return (obSide === "Dr" ? ob.neg() : ob).toFixed(2);
              }
              return statementRows[firstIdx - 1].runningBalance;
            })()
          : runningBalance.toFixed(2);

      res.json({
        account: {
          id: account.id,
          name: account.name,
          code: account.code,
          openingBalance: account.openingBalance,
          openingBalanceSide: account.openingBalanceSide,
        },
        paymentTermsDays,
        openingBalance: filteredOpeningBalance,
        closingBalance:
          filteredRows.length > 0 ? filteredRows[filteredRows.length - 1].runningBalance : runningBalance.toFixed(2),
        rows: filteredRows,
      });
    } catch (err: unknown) {
      logger.error("[TransporterStatement]", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
