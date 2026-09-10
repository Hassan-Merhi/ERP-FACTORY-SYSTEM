import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db, type RawQueryRow } from "../db";
import { requireAuth, requireNonPOS } from "../auth";
import { ledgerAccounts, containers } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { parseId } from "../lib/parseId";
import { getActiveRecipients, sendWhatsAppTextToChatId, sendWhatsAppFileToChatId } from "../services/whatsappService";
import { toFiniteNumber, toPositiveInteger } from "@shared/typeGuards";

/**
 * Voucher-entry rows behind the transporter statement.
 *
 * These are raw projections, so the columns keep their database names and the
 * `numeric` amounts arrive as decimal strings. Nullability follows the schema:
 * `voucher_date`, `voucher_number` and `voucher_type` are NOT NULL, while the
 * narration, description and the LEFT JOINed due date are not.
 */
interface TransporterSummaryRow {
  id: number;
  debit_amount: string | null;
  credit_amount: string | null;
  voucher_date: string;
}

interface TransporterStatementRow extends TransporterSummaryRow {
  voucher_id: number;
  narration: string | null;
  voucher_description: string | null;
  voucher_number: string;
  voucher_type: string;
  manual_due_date: string | null;
}

/** Allocated payment total per credit entry; `SUM(numeric)` returns a string. */
interface AllocationTotalRow {
  credit_entry_id: number | string | null;
  paid_amount: string | null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Extract a container number (4 letters + 7 digits) from free text
function extractContainerNumber(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/\b([A-Z]{4}[0-9]{7})\b/);
  return m ? m[1] : null;
}

// ── route registration ────────────────────────────────────────────────────────

export function registerTransporterStatementRoutes(app: Express) {
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

      if (dueDate) {
        await db.execute(
          sql`INSERT INTO transporter_entry_due_dates (voucher_entry_id, company_id, due_date)
              VALUES (${entryId}, ${companyId}, ${dueDate})
              ON CONFLICT (voucher_entry_id)
              DO UPDATE SET due_date = EXCLUDED.due_date, updated_at = now()`
        );
      } else {
        await db.execute(sql`DELETE FROM transporter_entry_due_dates WHERE voucher_entry_id = ${entryId}`);
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
      const paidMap = new Map<number, number>();
      for (const a of allocRows.rows) {
        const creditEntryId = toPositiveInteger(a.credit_entry_id);
        if (creditEntryId === undefined) continue;
        paidMap.set(creditEntryId, toFiniteNumber(a.paid_amount) ?? 0);
      }

      const allRows = rawEntries.rows;
      let totalCharged = 0;
      let totalPaid = 0;
      let runningBalance = 0;
      let overdueCount = 0;
      const now = new Date().toISOString().slice(0, 10);

      for (const row of allRows) {
        const debit = parseFloat(row.debit_amount || "0");
        const credit = parseFloat(row.credit_amount || "0");
        runningBalance += credit - debit;
        const inRange = (!dateFrom || row.voucher_date >= dateFrom) && (!dateTo || row.voucher_date <= dateTo);
        if (inRange) {
          totalCharged += credit;
          totalPaid += debit;
        }
        if (credit > 0) {
          const paid = paidMap.get(row.id) ?? 0;
          if (paid < credit - 0.005 && row.voucher_date <= now) overdueCount++;
        }
      }

      const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
        .filter((e) => parseFloat(e.credit_amount || "0") > 0)
        .map((e) => ({ id: e.id, total: parseFloat(e.credit_amount), remaining: parseFloat(e.credit_amount) }));

      const debitEntries = entries
        .filter((e) => parseFloat(e.debit_amount || "0") > 0)
        .map((e) => ({ id: e.id, total: parseFloat(e.debit_amount), remaining: parseFloat(e.debit_amount) }));

      // Clear existing allocations for this account
      await db.execute(
        sql`DELETE FROM transporter_payment_allocations WHERE company_id = ${companyId}
            AND (credit_entry_id = ANY(${sql.raw(`ARRAY[${creditEntries.map((c) => c.id).join(",") || "NULL"}]::integer[]`)})
              OR debit_entry_id = ANY(${sql.raw(`ARRAY[${debitEntries.map((d) => d.id).join(",") || "NULL"}]::integer[]`)}))`
      );

      // FIFO: iterate debits in date order, distribute against oldest unpaid credits
      const newAllocations: Array<{ debitId: number; creditId: number; amount: number }> = [];

      for (const debit of debitEntries) {
        let debitRemaining = debit.remaining;
        for (const credit of creditEntries) {
          if (debitRemaining <= 0) break;
          if (credit.remaining <= 0) continue;

          const alloc = Math.min(debitRemaining, credit.remaining);
          newAllocations.push({ debitId: debit.id, creditId: credit.id, amount: alloc });
          debitRemaining -= alloc;
          credit.remaining -= alloc;
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
      const ob = parseFloat(account.openingBalance || "0");
      const obSide = account.openingBalanceSide;
      let runningBalance = obSide === "Dr" ? -ob : ob;

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
          const amount = toFiniteNumber(r[column]);
          if (amount === undefined || amount <= 0) return [];
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
      const preSystemBalance = obSide === "Cr" ? ob : -ob; // positive = we owe from before
      const totalVoucherPayments = fifoPayments.reduce((s, p) => s + p.total, 0);
      let payPool = Math.max(0, totalVoucherPayments - Math.max(0, preSystemBalance));

      const paidMap = new Map<number, number>(); // chargeEntryId → paidAmount
      for (const charge of fifoCharges) {
        if (payPool <= 0) break;
        const alloc = Math.min(payPool, charge.remaining);
        if (alloc > 0) {
          paidMap.set(charge.id, (paidMap.get(charge.id) ?? 0) + alloc);
          payPool -= alloc;
          charge.remaining -= alloc;
        }
      }

      // Build rows with running balance
      const statementRows = allRows.map((row) => {
        const debit = parseFloat(row.debit_amount || "0");
        const credit = parseFloat(row.credit_amount || "0");
        runningBalance = runningBalance + credit - debit;

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
        if (credit > 0) {
          const paid = paidMap.get(row.id) ?? 0;
          paidAmount = paid.toFixed(2);
          if (paid <= 0) {
            status = "unpaid";
          } else if (paid >= credit - 0.005) {
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
          debit: debit > 0 ? debit.toFixed(2) : null,
          credit: credit > 0 ? credit.toFixed(2) : null,
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
                return (obSide === "Dr" ? -ob : ob).toFixed(2);
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
