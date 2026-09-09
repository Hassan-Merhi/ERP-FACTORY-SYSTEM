import type { Express, Request, Response } from "express";
import { and, eq, ilike } from "drizzle-orm";
import { insuranceMembers, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { logger } from "../../lib/logger";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";

const APPLY_CONFIRMATION = "REPAIR_REVERSED_INSURANCE_JOURNALS";

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
