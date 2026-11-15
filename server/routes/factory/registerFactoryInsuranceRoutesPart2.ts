// Extracted from ./factoryInsuranceRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { auditLog, insuranceMemberMonthlyAmounts, insuranceMembers, ledgerAccounts, vouchers } from "@shared/schema";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import {
  privilegedDestructiveRateLimit,
  privilegedMutationRateLimit,
} from "../../middleware/privilegedEndpointSecurity";
import type { InsuranceImportRow } from "../../services/factory/insuranceWorkbookImport";
import { retireVouchersTx, sessionRetirementActor } from "../../services/accounting/voucherRetirement";
import {
  CLEAR_CONFIRMATION,
  findOrCreateLedgerTx,
  insuranceImportApplySchema,
  normalizedMemberName,
  sendRouteError,
} from "./factoryInsuranceRoutesFindOrCreateLedgerTx";

export function registerFactoryInsuranceRoutesPart2(app: Express) {
  app.post(
    "/api/insurance/import/apply",
    privilegedMutationRateLimit,
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const parsed = insuranceImportApplySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ message: "Invalid import data", errors: parsed.error.issues });
        }
        const companyId = resolveRequestCompanyId(req);
        const rows = parsed.data.rows as InsuranceImportRow[];
        const duplicateKeys = new Set<string>();
        for (const row of rows) {
          const key = `${row.monthStart}:${normalizedMemberName(row.name)}`;
          if (duplicateKeys.has(key)) {
            return res.status(400).json({ message: `Duplicate member ${row.name} for ${row.monthStart}` });
          }
          duplicateKeys.add(key);
        }

        const result = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"insurance-import:" + companyId}))`);
          const existingRows = await tx
            .select()
            .from(insuranceMembers)
            .where(eq(insuranceMembers.companyId, companyId));
          const existingByName = new Map<string, typeof existingRows>();
          for (const member of existingRows) {
            const key = normalizedMemberName(member.name);
            existingByName.set(key, [...(existingByName.get(key) ?? []), member]);
          }
          for (const [name, matches] of existingByName) {
            if (matches.length > 1) {
              throw new Error(
                `Existing Insurance data has duplicate member name "${name}". Resolve it before importing.`
              );
            }
          }

          const rowsByMember = new Map<string, InsuranceImportRow[]>();
          for (const row of rows) {
            const key = normalizedMemberName(row.name);
            rowsByMember.set(key, [...(rowsByMember.get(key) ?? []), row]);
          }

          let createdMembers = 0;
          let updatedMembers = 0;
          let monthlyAmountsUpserted = 0;
          for (const [memberKey, memberRows] of rowsByMember) {
            memberRows.sort((a, b) => a.monthStart.localeCompare(b.monthStart));
            let member = existingByName.get(memberKey)?.[0];
            if (!member) {
              const firstRow = memberRows[0];
              const earliestStartDate = memberRows.reduce(
                (earliest, row) => (row.startDate < earliest ? row.startDate : earliest),
                firstRow.startDate
              );
              const ledger = await findOrCreateLedgerTx(tx, companyId, `Insurance - ${firstRow.name}`, "Liability");
              const [inserted] = await tx
                .insert(insuranceMembers)
                .values({
                  companyId,
                  name: firstRow.name,
                  nationality: firstRow.nationality ?? null,
                  positionWorking: firstRow.positionWorking ?? null,
                  insuranceNumber: firstRow.insuranceNumber ?? null,
                  startDate: earliestStartDate,
                  amount: memberRows[memberRows.length - 1].amount,
                  dob: firstRow.dob ?? null,
                  notes: firstRow.notes ?? null,
                  active: true,
                  ledgerAccountId: ledger.id,
                })
                .returning();
              if (!inserted) throw new Error(`Failed to create Insurance member ${firstRow.name}`);
              member = inserted;
              existingByName.set(memberKey, [member]);
              createdMembers += 1;
            } else {
              updatedMembers += 1;
            }

            for (const row of memberRows) {
              await tx
                .insert(insuranceMemberMonthlyAmounts)
                .values({
                  companyId,
                  memberId: member.id,
                  monthStart: row.monthStart,
                  amount: row.amount,
                })
                .onConflictDoUpdate({
                  target: [
                    insuranceMemberMonthlyAmounts.companyId,
                    insuranceMemberMonthlyAmounts.memberId,
                    insuranceMemberMonthlyAmounts.monthStart,
                  ],
                  set: { amount: row.amount, updatedAt: new Date() },
                });
              monthlyAmountsUpserted += 1;
            }

            const [latestAmount] = await tx
              .select({ amount: insuranceMemberMonthlyAmounts.amount })
              .from(insuranceMemberMonthlyAmounts)
              .where(
                and(
                  eq(insuranceMemberMonthlyAmounts.companyId, companyId),
                  eq(insuranceMemberMonthlyAmounts.memberId, member.id)
                )
              )
              .orderBy(desc(insuranceMemberMonthlyAmounts.monthStart))
              .limit(1);
            if (latestAmount) {
              await tx
                .update(insuranceMembers)
                .set({ amount: latestAmount.amount })
                .where(and(eq(insuranceMembers.companyId, companyId), eq(insuranceMembers.id, member.id)));
            }
          }

          await tx.insert(auditLog).values({
            userId: String(req.session.userId ?? "system"),
            username: req.session.username ?? "unknown",
            companyId,
            action: "import",
            tableName: "insurance_members",
            recordIdentifier: "multi-sheet-excel-import",
            changes: {
              createdMembers: { old: null, new: createdMembers },
              updatedMembers: { old: null, new: updatedMembers },
              monthlyAmountsUpserted: { old: null, new: monthlyAmountsUpserted },
            },
          });
          return { createdMembers, updatedMembers, monthlyAmountsUpserted };
        });
        return res.json(result);
      } catch (error: unknown) {
        logger.error("POST /api/insurance/import/apply error:", { error });
        sendRouteError(res, error, "Failed to import Insurance workbook");
      }
    }
  );

  app.post(
    "/api/insurance/admin/clear-all",
    privilegedDestructiveRateLimit,
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const companyId = resolveRequestCompanyId(req);
        if (req.body?.confirmation !== CLEAR_CONFIRMATION) {
          return res.status(400).json({
            message: `Type ${CLEAR_CONFIRMATION} to confirm`,
            confirmationRequired: CLEAR_CONFIRMATION,
          });
        }

        const result = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"insurance-clear:" + companyId}))`);
          const members = await tx
            .select({ id: insuranceMembers.id, ledgerAccountId: insuranceMembers.ledgerAccountId })
            .from(insuranceMembers)
            .where(eq(insuranceMembers.companyId, companyId));
          const insuranceAccounts = await tx
            .select({ id: ledgerAccounts.id })
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, companyId),
                or(eq(ledgerAccounts.name, "Insurance Expense"), ilike(ledgerAccounts.name, "Insurance - %"))
              )
            );
          const insuranceVouchers = await tx
            .select({ id: vouchers.id })
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, companyId),
                ilike(vouchers.voucherNumber, "INS-%"),
                or(eq(vouchers.sourceModule, "ERP"), isNull(vouchers.sourceModule))
              )
            );
          const voucherIds = insuranceVouchers.map((voucher) => voucher.id);
          const accountIds = Array.from(
            new Set([
              ...insuranceAccounts.map((account) => account.id),
              ...members.map((member) => member.ledgerAccountId).filter((id): id is number => typeof id === "number"),
            ])
          );

          if (voucherIds.length > 0) {
            // Wave 16 (A): retired (soft delete with lines, audited here, numbers
            // and posting identities released), not hard-deleted.
            await retireVouchersTx(tx, {
              companyId,
              voucherIds,
              reason: "insurance-clear-all",
              actor: sessionRetirementActor(req),
            });
          }
          await tx.delete(insuranceMemberMonthlyAmounts).where(eq(insuranceMemberMonthlyAmounts.companyId, companyId));
          await tx.delete(insuranceMembers).where(eq(insuranceMembers.companyId, companyId));
          if (accountIds.length > 0) {
            await tx
              .update(ledgerAccounts)
              .set({ deletedAt: new Date(), active: false })
              .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, accountIds)));
          }

          await tx.insert(auditLog).values({
            userId: String(req.session.userId ?? "system"),
            username: req.session.username ?? "unknown",
            companyId,
            action: "delete",
            tableName: "insurance_reset",
            recordIdentifier: CLEAR_CONFIRMATION,
            changes: {
              membersDeleted: { old: members.length, new: 0 },
              vouchersDeleted: { old: voucherIds.length, new: 0 },
              ledgerAccountsArchived: { old: accountIds.length, new: 0 },
            },
          });
          return {
            membersDeleted: members.length,
            vouchersDeleted: voucherIds.length,
            voucherEntriesDeleted: false,
            monthlyAmountsDeleted: true,
            ledgerAccountsArchived: accountIds.length,
          };
        });

        logger.warn("Insurance records cleared", {
          companyId,
          userId: req.session.userId ?? null,
          ...result,
        });
        return res.json(result);
      } catch (error: unknown) {
        logger.error("POST /api/insurance/admin/clear-all error:", { error });
        sendRouteError(res, error, "Failed to clear Insurance records");
      }
    }
  );
}
