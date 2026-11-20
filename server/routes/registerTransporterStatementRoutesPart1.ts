// Extracted from ./transporterStatementRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db, type RawQueryRow } from "../db";
import { requireAuth, requireNonPOS } from "../auth";
import { ledgerAccounts } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { parseId } from "../lib/parseId";
import { getActiveRecipients, sendWhatsAppFileToChatId, sendWhatsAppTextToChatId } from "../services/whatsappService";
import { toPositiveInteger } from "@shared/typeGuards";
import { MoneyDecimal, sumMoney, toMoney } from "../lib/money";
import type Decimal from "decimal.js";
import type { TransporterSummaryRow, AllocationTotalRow } from "./registerTransporterStatementRoutesPart1Helpers";
export {
  addDays,
  extractContainerNumber,
  type TransporterStatementRow,
} from "./registerTransporterStatementRoutesPart1Helpers";

// ── helpers ──────────────────────────────────────────────────────────────────

export function registerTransporterStatementRoutesPart1(app: Express) {
  // GET /api/transporter-statement/transporters
  // Returns only Loans accounts whose name matches a transporter currently
  // used in an active OTW container for this company (case-insensitive).
  app.get("/api/transporter-statement/transporters", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const result = await db.execute(sql`
        SELECT DISTINCT
          la.id,
          la.name,
          la.code,
          la.account_type  AS "accountType",
          la.opening_balance       AS "openingBalance",
          la.opening_balance_side  AS "openingBalanceSide"
        FROM ledger_accounts la
        WHERE la.company_id = ${companyId}
          AND la.account_type = 'Loans'
          AND la.deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM containers c
            WHERE c.company_id = ${companyId}
              AND LOWER(TRIM(c.transporter)) = LOWER(TRIM(la.name))
              AND c.status NOT IN ('OFFLOADED','CLOSED','COMPLETED')
          )
        ORDER BY la.name
      `);

      res.json(result.rows);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // GET /api/transporter-statement/:accountId/settings
  app.get("/api/transporter-statement/:accountId/settings", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accountId = parseId(req.params.accountId);
      if (accountId === null) return res.status(400).json({ message: "Invalid account ID" });

      const rows = await db.execute(
        sql`SELECT payment_terms_days FROM transporter_payment_settings
            WHERE company_id = ${companyId} AND ledger_account_id = ${accountId} LIMIT 1`
      );
      const row = rows.rows?.[0] as { payment_terms_days: number } | undefined;
      res.json({ paymentTermsDays: row?.payment_terms_days ?? 0 });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // PUT /api/transporter-statement/:accountId/settings
  app.put("/api/transporter-statement/:accountId/settings", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accountId = parseId(req.params.accountId);
      if (accountId === null) return res.status(400).json({ message: "Invalid account ID" });

      const { paymentTermsDays } = z
        .object({
          paymentTermsDays: z.number().int().min(0).max(365),
        })
        .parse(req.body);

      await db.execute(
        sql`INSERT INTO transporter_payment_settings (company_id, ledger_account_id, payment_terms_days)
            VALUES (${companyId}, ${accountId}, ${paymentTermsDays})
            ON CONFLICT (company_id, ledger_account_id)
            DO UPDATE SET payment_terms_days = EXCLUDED.payment_terms_days, updated_at = now()`
      );

      res.json({ paymentTermsDays });
    } catch (err: unknown) {
      res.status(400).json({ message: getErrorMessage(err) });
    }
  });

  // PUT /api/transporter-entry-due-dates/:entryId
  app.put("/api/transporter-entry-due-dates/:entryId", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const entryId = parseId(req.params.entryId);
      if (entryId === null) return res.status(400).json({ message: "Invalid entry ID" });

      const { dueDate } = z
        .object({
          dueDate: z.string().nullable(),
        })
        .parse(req.body);

      // The voucher line must belong to the caller's company, and a due date
      // stored by another company is never overwritten or deleted.
      const owned = await db.execute(
        sql`SELECT 1 FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
             WHERE e.id = ${entryId} AND v.company_id = ${companyId}`
      );
      if (owned.rows.length === 0) return res.status(404).json({ message: "Entry not found" });

      if (dueDate) {
        const written = await db.execute(
          sql`INSERT INTO transporter_entry_due_dates (voucher_entry_id, company_id, due_date)
              VALUES (${entryId}, ${companyId}, ${dueDate})
              ON CONFLICT (voucher_entry_id)
              DO UPDATE SET due_date = EXCLUDED.due_date, updated_at = now()
              WHERE transporter_entry_due_dates.company_id = EXCLUDED.company_id
              RETURNING voucher_entry_id`
        );
        if (written.rows.length === 0) return res.status(404).json({ message: "Entry not found" });
      } else {
        await db.execute(
          sql`DELETE FROM transporter_entry_due_dates WHERE voucher_entry_id = ${entryId} AND company_id = ${companyId}`
        );
      }

      res.json({ ok: true, dueDate });
    } catch (err: unknown) {
      res.status(400).json({ message: getErrorMessage(err) });
    }
  });

  // POST /api/transporter-statement/:accountId/send-whatsapp
  // Sends a text summary of the outstanding balance to all active WhatsApp recipients.
  app.post("/api/transporter-statement/:accountId/send-whatsapp", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accountId = parseId(req.params.accountId);
      if (accountId === null) return res.status(400).json({ message: "Invalid account ID" });

      const { dateFrom, dateTo, imageBase64 } = z
        .object({
          dateFrom: z.string().optional(),
          dateTo: z.string().optional(),
          imageBase64: z.string().optional(),
        })
        .parse(req.body);

      // Verify account
      const [account] = await db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)))
        .limit(1);
      if (!account) return res.status(404).json({ message: "Account not found" });

      // Fetch all entries (unbounded) for running balance
      const rawEntries = await db.execute<RawQueryRow<TransporterSummaryRow>>(sql`
        SELECT ve.id, ve.debit_amount, ve.credit_amount, v.voucher_date
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_account_id = ${accountId}
          AND v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND (v.optional IS DISTINCT FROM true)
        ORDER BY v.voucher_date ASC, ve.id ASC
      `);

      // Fetch paid amounts from allocations
      const allocRows = await db.execute<RawQueryRow<AllocationTotalRow>>(sql`
        SELECT credit_entry_id, SUM(allocated_amount) AS paid_amount
        FROM transporter_payment_allocations
        WHERE company_id = ${companyId}
        GROUP BY credit_entry_id
      `);
      const paidMap = new Map<number, Decimal>();
      for (const a of allocRows.rows) {
        const creditEntryId = toPositiveInteger(a.credit_entry_id);
        if (creditEntryId === undefined) continue;
        paidMap.set(creditEntryId, toMoney(a.paid_amount as string | number | null));
      }

      const allRows = rawEntries.rows;
      const charged: Decimal[] = [];
      const paidOut: Decimal[] = [];
      let runningBalance: Decimal = new MoneyDecimal(0);
      let overdueCount = 0;
      const now = new Date().toISOString().slice(0, 10);

      for (const row of allRows) {
        const debit = toMoney(row.debit_amount);
        const credit = toMoney(row.credit_amount);
        runningBalance = runningBalance.plus(credit).minus(debit);
        const inRange = (!dateFrom || row.voucher_date >= dateFrom) && (!dateTo || row.voucher_date <= dateTo);
        if (inRange) {
          charged.push(credit);
          paidOut.push(debit);
        }
        if (credit.gt(0)) {
          const paid = paidMap.get(row.id) ?? new MoneyDecimal(0);
          if (paid.lt(credit.minus(0.005)) && row.voucher_date <= now) overdueCount++;
        }
      }
      const totalCharged = sumMoney(charged);
      const totalPaid = sumMoney(paidOut);

      const fmt = (n: Decimal) =>
        n.toDecimalPlaces(2).toNumber().toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      const periodLine =
        dateFrom && dateTo
          ? `Period: ${dateFrom} → ${dateTo}`
          : dateFrom
            ? `From: ${dateFrom}`
            : dateTo
              ? `To: ${dateTo}`
              : "All time";

      const message = [
        `*Transporter Statement*`,
        `Account: ${account.name}`,
        periodLine,
        ``,
        `Total Charged: ${fmt(totalCharged)}`,
        `Total Paid:    ${fmt(totalPaid)}`,
        `*Outstanding:  ${fmt(runningBalance)}*`,
        overdueCount > 0 ? `⚠️ ${overdueCount} entry/entries overdue` : `All entries current`,
        ``,
        `Sent on ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`,
      ].join("\n");

      const recipients = await getActiveRecipients();
      if (!recipients.length) {
        return res.status(400).json({ message: "No active WhatsApp recipients configured" });
      }

      let sent = 0;
      let failed = 0;
      const errors: string[] = [];

      if (imageBase64) {
        // Send as image
        const base64Data = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        const fileName = `TransporterStatement_${account.name}_${new Date().toISOString().substring(0, 10)}.png`;
        for (const r of recipients) {
          const result = await sendWhatsAppFileToChatId(r.chatId, buffer, fileName, message, "image/png");
          if (result.success) {
            sent++;
          } else {
            failed++;
            if (result.error) errors.push(result.error);
          }
        }
      } else {
        // Fallback: send as text
        for (const r of recipients) {
          const result = await sendWhatsAppTextToChatId(r.chatId, message);
          if (result.success) {
            sent++;
          } else {
            failed++;
            if (result.error) errors.push(result.error);
          }
        }
      }

      res.json({ ok: true, sent, failed, errors });
    } catch (err: unknown) {
      logger.error("[TransporterStatement/send-whatsapp]", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
