import type { Express, Request, Response } from "express";
import { and, eq, ilike } from "drizzle-orm";
import { insuranceMembers, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { db, pool } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { logger } from "../../lib/logger";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";

const APPLY_CONFIRMATION = "REPAIR_REVERSED_INSURANCE_JOURNALS";
const AUTO_REPAIR_LOCK = "insurance-generated-journal-direction-v2";

type InsuranceEntryRow = {
  entryId: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  ledgerAccountId: number | null;
  ledgerName: string | null;
  accountType: string | null;
  debitAmount: string;
  creditAmount: string;
};

type Candidate = {
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  total: number;
  entries: InsuranceEntryRow[];
};

type Skipped = {
  voucherId: number;
  voucherNumber: string;
  reason: string;
};

function money(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Automatically repairs insurance journals that were generated with the old
 * direction (Dr Insurance Expense / Cr Insurance member liability).
 *
 * The repair is intentionally narrow and idempotent:
 * - only ERP INS-* vouchers are considered;
 * - each voucher must contain exactly one Insurance Expense leg and one or
 *   more recognized Insurance member liability legs, with no extra accounts;
 * - the old-side amounts must balance before anything is changed;
 * - a cross-process advisory lock prevents two app instances from flipping the
 *   same voucher twice during a rolling deploy.
 *
 * Once repaired, the voucher no longer matches the legacy-side predicate, so
 * later startups are no-ops.
 */
export async function autoRepairHistoricalInsuranceJournalDirections(): Promise<number[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [AUTO_REPAIR_LOCK]);

    const repaired = await client.query<{ voucher_id: number }>(`
      WITH classified AS (
        SELECT
          v.id AS voucher_id,
          v.company_id,
          ve.id AS entry_id,
          COALESCE(ve.debit_amount, 0)::numeric AS debit_amount,
          COALESCE(ve.credit_amount, 0)::numeric AS credit_amount,
          (la.name = 'Insurance Expense' AND la.account_type = 'Expense') AS is_expense,
          (
            la.account_type = 'Liability'
            AND (
              la.name LIKE 'Insurance - %'
              OR EXISTS (
                SELECT 1
                FROM insurance_members im
                WHERE im.company_id = v.company_id
                  AND im.ledger_account_id = la.id
              )
            )
          ) AS is_liability
        FROM vouchers v
        JOIN voucher_entries ve ON ve.voucher_id = v.id
        LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE v.source_module = 'ERP'
          AND v.voucher_number ILIKE 'INS-%'
      ),
      candidate_vouchers AS (
        SELECT voucher_id
        FROM classified
        GROUP BY voucher_id
        HAVING COUNT(*) FILTER (WHERE is_expense) = 1
          AND COUNT(*) FILTER (WHERE is_liability) > 0
          AND COUNT(*) = COUNT(*) FILTER (WHERE is_expense OR is_liability)
          AND SUM(CASE WHEN is_expense THEN debit_amount ELSE 0 END) > 0
          AND SUM(CASE WHEN is_expense THEN credit_amount ELSE 0 END) = 0
          AND BOOL_AND(
            CASE
              WHEN is_liability THEN debit_amount = 0 AND credit_amount > 0
              ELSE TRUE
            END
          )
          AND ABS(
            SUM(CASE WHEN is_expense THEN debit_amount ELSE 0 END)
            - SUM(CASE WHEN is_liability THEN credit_amount ELSE 0 END)
          ) <= 0.01
      ),
      updated AS (
        UPDATE voucher_entries ve
        SET
          debit_amount = ve.credit_amount,
          credit_amount = ve.debit_amount
        FROM candidate_vouchers cv
        WHERE ve.voucher_id = cv.voucher_id
        RETURNING ve.voucher_id
      )
      SELECT DISTINCT voucher_id FROM updated ORDER BY voucher_id
    `);

    await client.query("COMMIT");
    const voucherIds = repaired.rows.map((row) => row.voucher_id);
    if (voucherIds.length > 0) {
      logger.warn("Automatically repaired legacy insurance journal directions", {
        repairedCount: voucherIds.length,
        repairedVoucherIds: voucherIds,
      });
    }
    return voucherIds;
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    logger.error("Automatic historical insurance journal direction repair failed", { error });
    return [];
  } finally {
    client.release();
  }
}

async function inspectHistoricalInsuranceJournals(companyId: number): Promise<{
  candidates: Candidate[];
  skipped: Skipped[];
}> {
  const rows = await db
    .select({
      entryId: voucherEntries.id,
      voucherId: vouchers.id,
      voucherNumber: vouchers.voucherNumber,
      voucherDate: vouchers.voucherDate,
      ledgerAccountId: voucherEntries.ledgerAccountId,
      ledgerName: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
      debitAmount: voucherEntries.debitAmount,
      creditAmount: voucherEntries.creditAmount,
    })
    .from(vouchers)
    .innerJoin(voucherEntries, eq(voucherEntries.voucherId, vouchers.id))
    .leftJoin(ledgerAccounts, eq(ledgerAccounts.id, voucherEntries.ledgerAccountId))
    .where(
      and(eq(vouchers.companyId, companyId), eq(vouchers.sourceModule, "ERP"), ilike(vouchers.voucherNumber, "INS-%"))
    );

  const linkedMemberLedgers = new Set(
    (
      await db
        .select({ ledgerAccountId: insuranceMembers.ledgerAccountId })
        .from(insuranceMembers)
        .where(eq(insuranceMembers.companyId, companyId))
    )
      .map((row) => row.ledgerAccountId)
      .filter((id): id is number => typeof id === "number")
  );

  const byVoucher = new Map<number, InsuranceEntryRow[]>();
  for (const row of rows as InsuranceEntryRow[]) {
    const list = byVoucher.get(row.voucherId) ?? [];
    list.push(row);
    byVoucher.set(row.voucherId, list);
  }

  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];

  for (const [voucherId, entries] of byVoucher) {
    const first = entries[0];
    const expenseEntries = entries.filter(
      (entry) => entry.ledgerName === "Insurance Expense" && entry.accountType === "Expense"
    );
    const liabilityEntries = entries.filter(
      (entry) =>
        entry.accountType === "Liability" &&
        ((entry.ledgerName ?? "").startsWith("Insurance - ") ||
          (entry.ledgerAccountId != null && linkedMemberLedgers.has(entry.ledgerAccountId)))
    );

    if (expenseEntries.length !== 1 || liabilityEntries.length === 0) {
      skipped.push({ voucherId, voucherNumber: first.voucherNumber, reason: "INSURANCE_LEDGER_PATTERN_NOT_PROVEN" });
      continue;
    }
    if (expenseEntries.length + liabilityEntries.length !== entries.length) {
      skipped.push({ voucherId, voucherNumber: first.voucherNumber, reason: "UNEXPECTED_EXTRA_LEDGER_ENTRY" });
      continue;
    }

    const expense = expenseEntries[0];
    const expenseDebit = money(expense.debitAmount);
    const expenseCredit = money(expense.creditAmount);
    const liabilityDebits = liabilityEntries.reduce((sum, entry) => sum + money(entry.debitAmount), 0);
    const liabilityCredits = liabilityEntries.reduce((sum, entry) => sum + money(entry.creditAmount), 0);

    if (![expenseDebit, expenseCredit, liabilityDebits, liabilityCredits].every(Number.isFinite)) {
      skipped.push({ voucherId, voucherNumber: first.voucherNumber, reason: "NON_NUMERIC_ENTRY_AMOUNT" });
      continue;
    }

    if (expenseDebit === 0 && expenseCredit > 0 && liabilityDebits > 0 && liabilityCredits === 0) {
      continue;
    }

    const allLiabilitiesOnLegacyCreditSide = liabilityEntries.every(
      (entry) => money(entry.debitAmount) === 0 && money(entry.creditAmount) > 0
    );
    const isLegacyReversed = expenseDebit > 0 && expenseCredit === 0 && allLiabilitiesOnLegacyCreditSide;
    if (!isLegacyReversed) {
      skipped.push({ voucherId, voucherNumber: first.voucherNumber, reason: "MIXED_OR_AMBIGUOUS_ENTRY_DIRECTION" });
      continue;
    }

    if (Math.abs(expenseDebit - liabilityCredits) > 0.01) {
      skipped.push({ voucherId, voucherNumber: first.voucherNumber, reason: "UNBALANCED_REVERSED_JOURNAL" });
      continue;
    }

    candidates.push({
      voucherId,
      voucherNumber: first.voucherNumber,
      voucherDate: first.voucherDate,
      total: expenseDebit,
      entries,
    });
  }

  return { candidates, skipped };
}

export function registerInsuranceHistoricalRepairRoutes(app: Express): void {
  // Run once when the route module is registered. This makes the old generated
  // entries self-heal on the first deployment containing this fix.
  void autoRepairHistoricalInsuranceJournalDirections();

  app.post(
    "/api/insurance/admin/repair-reversed-journals",
    requireAuth,
    requireRole("Admin"),
    async (req: Request, res: Response) => {
      try {
        const companyId = resolveRequestCompanyId(req);
        const dryRun = req.body?.dryRun !== false;
        const inspection = await inspectHistoricalInsuranceJournals(companyId);

        if (dryRun) {
          return res.json({
            dryRun: true,
            confirmationRequired: APPLY_CONFIRMATION,
            candidateCount: inspection.candidates.length,
            candidates: inspection.candidates.map(({ entries: _entries, ...candidate }) => candidate),
            skippedCount: inspection.skipped.length,
            skipped: inspection.skipped,
          });
        }

        if (req.body?.confirmation !== APPLY_CONFIRMATION) {
          return res.status(400).json({
            message: `Set confirmation to ${APPLY_CONFIRMATION} to apply the repair`,
          });
        }

        const repairedVoucherIds = await db.transaction(async (tx) => {
          const repaired: number[] = [];
          for (const candidate of inspection.candidates) {
            let updatedEntries = 0;
            for (const entry of candidate.entries) {
              const result = await tx
                .update(voucherEntries)
                .set({ debitAmount: entry.creditAmount, creditAmount: entry.debitAmount })
                .where(
                  and(
                    eq(voucherEntries.id, entry.entryId),
                    eq(voucherEntries.voucherId, candidate.voucherId),
                    eq(voucherEntries.debitAmount, entry.debitAmount),
                    eq(voucherEntries.creditAmount, entry.creditAmount)
                  )
                )
                .returning({ id: voucherEntries.id });
              updatedEntries += result.length;
            }
            if (updatedEntries !== candidate.entries.length) {
              throw new Error(
                `Insurance voucher ${candidate.voucherNumber} changed during repair; transaction rolled back`
              );
            }
            repaired.push(candidate.voucherId);
          }
          return repaired;
        });

        logger.info(
          JSON.stringify({
            event: "historical_insurance_journal_repair_applied",
            userId: req.session.userId ?? null,
            companyId,
            repairedVoucherIds,
            repairedCount: repairedVoucherIds.length,
          })
        );

        return res.json({
          dryRun: false,
          repairedCount: repairedVoucherIds.length,
          repairedVoucherIds,
          skippedCount: inspection.skipped.length,
          skipped: inspection.skipped,
        });
      } catch (error: unknown) {
        logger.error("POST /api/insurance/admin/repair-reversed-journals error", { error });
        return res.status(500).json({
          message: error instanceof Error ? error.message : "Failed to repair historical insurance journals",
        });
      }
    }
  );
}
