/**
 * voucherEntryRoutes: VoucherBulkDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { recalculateIntercompanyForDate } from "../helpers/intercompanyHelpers";
import { softDeleteInterCompanyCounterpartTx } from "./delete";
import { MoneyDecimal, moneyString, toMoney } from "../../lib/money";
import { syncEmployeeBalancesFromEntries } from "../_helpers";
import { readVoucherAuditState, writeVoucherAuditTx } from "../helpers/voucherAuditTrail";
import {
  vouchers,
  voucherEntries,
  interCompanyTransfers,
  salaryAdvances,
  salaryAdvanceDeductions,
  propertyPayments,
  erpPayrollRuns,
  erpPayrollRunItems,
  intercompanyPaymentRequests,
} from "@shared/schema";
import { eq, and, or, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { reverseVoucherStockTx } from "../../services/inventory/voucherStockReversal";
import { syncPurchaseOrderGitForVoucherTx } from "../../services/accounting/perpetualInventory/stockReceipts";
import { syncFactoryInvoiceForChargeVoucherTx } from "../../services/accounting/perpetualInventory/factoryInvoice";

export function registerVoucherBulkDeleteRoutes(app: Express) {
  // Bulk delete vouchers (Admin only) - uses same deletion logic as single delete
  app.post("/api/vouchers/bulk-delete", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      // Validate request body with Zod
      const bodySchema = z.object({
        voucherIds: z.array(z.union([z.number(), z.string()])).min(1, "At least one voucher ID required"),
      });

      const parseResult = bodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: parseResult.error.issues[0].message });
      }

      const { voucherIds } = parseResult.data;

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const currentCompanyId = req.session.currentCompanyId;
      let deletedCount = 0;
      const errors: string[] = [];
      const intercompanyDatesToRecalc = new Set<string>();

      // Process each voucher deletion using the same logic as single delete
      for (const voucherId of voucherIds) {
        const id = typeof voucherId === "string" ? parseInt(voucherId) : voucherId;
        if (isNaN(id)) {
          errors.push(`Invalid voucher ID: ${voucherId}`);
          continue;
        }

        try {
          // Get voucher and verify it belongs to current company
          const voucher = await storage.getVoucherById(id);
          if (!voucher) {
            errors.push(`Voucher ${id} not found`);
            continue;
          }

          if (voucher.companyId !== currentCompanyId) {
            errors.push(`Voucher ${id} does not belong to current company`);
            continue;
          }

          const blockedVoucherReason = voucherMutationBlockReason(voucher);
          if (blockedVoucherReason) {
            errors.push(`Voucher ${id}: ${blockedVoucherReason}`);
            continue;
          }

          const occurredAt = new Date().toISOString();

          // Use the same transaction-wrapped deletion logic as the single delete endpoint
          await db.transaction(async (tx) => {
            const auditBefore = await readVoucherAuditState(tx, id);
            // Wave 11: every stock document moves back exactly the value its
            // lines moved, and a sale's COGS journal leaves with it.
            await reverseVoucherStockTx(tx, {
              companyId: currentCompanyId,
              voucher,
              occurredAt,
              actor: {
                userId: req.session.userId,
                username: req.session.username,
                reason: `Bulk delete voucher ${voucher.voucherNumber}`,
              },
              sourcePrefix: "bulk_voucher_delete",
              keyPrefix: "bulk-voucher-delete",
            });

            // Reverse employee balance effects for non-optional vouchers
            if (!voucher.optional) {
              const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, id));

              await syncEmployeeBalancesFromEntries(
                entries.map((e) => ({
                  ledgerAccountId: e.ledgerAccountId,
                  employeeId: e.employeeId,
                  debitAmount: e.debitAmount,
                  creditAmount: e.creditAmount,
                })),
                currentCompanyId,
                true, // reverse
                tx
              );
            }

            // IMPORTANT: If this voucher is linked to a property payment entry,
            // reverse the monthly ledger and delete the payment log row so the
            // rent balance and payment history stay consistent.
            const linkedPayments = await tx.select().from(propertyPayments).where(eq(propertyPayments.voucherId, id));
            for (const pmt of linkedPayments) {
              if (pmt.ledgerRowId) {
                await tx.execute(sql`
                  UPDATE property_monthly_ledger
                  SET paid_amount = GREATEST(0, paid_amount - ${pmt.amount}::numeric)
                  WHERE id = ${pmt.ledgerRowId}
                `);
              }
              await tx.delete(propertyPayments).where(eq(propertyPayments.id, pmt.id));
            }

            // IMPORTANT: If this voucher is one side of an inter-company transfer,
            // also take the OTHER side out of the books and remove the transfer record,
            // so both companies' books stay consistent.
            const linkedTransfers = await tx
              .select()
              .from(interCompanyTransfers)
              .where(or(eq(interCompanyTransfers.fromVoucherId, id), eq(interCompanyTransfers.toVoucherId, id)));
            for (const transfer of linkedTransfers) {
              await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, transfer.id));
              // Wave 9: the other side is soft-deleted (lines kept) and audited
              // under its own company in this transaction, never hard-deleted.
              await softDeleteInterCompanyCounterpartTx(tx, {
                transfer,
                voucherId: id,
                voucherNumber: voucher.voucherNumber,
                actor: { userId: req.session.userId, username: req.session.username },
              });
            }

            // Clean up any pending IC notification requests for this voucher
            await tx
              .delete(intercompanyPaymentRequests)
              .where(
                and(
                  eq(intercompanyPaymentRequests.fromVoucherId, id),
                  eq(intercompanyPaymentRequests.status, "pending")
                )
              );

            // Soft delete: Set deletedAt instead of hard delete
            await tx.update(vouchers).set({ deletedAt: new Date() }).where(eq(vouchers.id, id));
            // Perpetual inventory (wave 8.2): a deleted PO voucher is no longer in transit.
            await syncPurchaseOrderGitForVoucherTx(tx, currentCompanyId, id);
            // Perpetual inventory (wave 8.4): an order whose charge this voucher carries re-syncs its invoice journal.
            await syncFactoryInvoiceForChargeVoucherTx(tx, currentCompanyId, id);

            // Cascade: remove factory daybook entries linked to this voucher
            await tx.execute(
              sql`DELETE FROM factory_daybook_entries WHERE reference_table = 'vouchers' AND reference_id = ${id}`
            );

            // If this is a SAL- payroll voucher, also reverse the payroll run
            if (voucher.voucherNumber && /^SAL-\d+-/.test(voucher.voucherNumber)) {
              const runIdMatch = voucher.voucherNumber.match(/^SAL-(\d+)-/);
              if (runIdMatch) {
                const payRunId = parseInt(runIdMatch[1]);
                const [payRun] = await tx
                  .select()
                  .from(erpPayrollRuns)
                  .where(
                    and(
                      eq(erpPayrollRuns.id, payRunId),
                      eq(erpPayrollRuns.companyId, currentCompanyId),
                      eq(erpPayrollRuns.status, "PAID")
                    )
                  );
                if (payRun) {
                  const runItems = await tx
                    .select()
                    .from(erpPayrollRunItems)
                    .where(eq(erpPayrollRunItems.runId, payRunId));
                  const payMonth = payRun.date.substring(0, 7);
                  for (const item of runItems) {
                    if (toMoney(item.deduction).lessThanOrEqualTo(0) || !item.employeeId) continue;
                    const empAdvances = await tx
                      .select({ id: salaryAdvances.id })
                      .from(salaryAdvances)
                      .where(
                        and(
                          eq(salaryAdvances.employeeId, item.employeeId),
                          eq(salaryAdvances.companyId, currentCompanyId)
                        )
                      );
                    const advIds = empAdvances.map((a) => a.id);
                    if (advIds.length === 0) continue;
                    const deductions = await tx
                      .select()
                      .from(salaryAdvanceDeductions)
                      .where(
                        and(
                          inArray(salaryAdvanceDeductions.salaryAdvanceId, advIds),
                          eq(salaryAdvanceDeductions.payrollMonth, payMonth)
                        )
                      );
                    for (const ded of deductions) {
                      const dedAmt = toMoney(ded.deductionAmount);
                      const [adv] = await tx
                        .select()
                        .from(salaryAdvances)
                        .where(eq(salaryAdvances.id, ded.salaryAdvanceId));
                      if (!adv) continue;
                      const newBal = MoneyDecimal.min(toMoney(adv.remainingBalance).plus(dedAmt), toMoney(adv.amount));
                      await tx
                        .update(salaryAdvances)
                        .set({ remainingBalance: moneyString(newBal), fullyPaid: false })
                        .where(eq(salaryAdvances.id, adv.id));
                      await tx.delete(salaryAdvanceDeductions).where(eq(salaryAdvanceDeductions.id, ded.id));
                    }
                  }
                  await tx
                    .update(erpPayrollRuns)
                    .set({ status: "DRAFT", paymentAccountId: null, paidAt: null })
                    .where(eq(erpPayrollRuns.id, payRunId));
                }
              }
            }

            // Wave 12 (decision 2): audited with every line in this transaction;
            // a failed audit write rolls this voucher's delete back.
            await writeVoucherAuditTx(tx, {
              actor: { userId: req.session.userId, username: req.session.username, companyId: currentCompanyId },
              action: "delete",
              voucherId: id,
              before: auditBefore,
              after: null,
              extra: { softDelete: { new: true }, bulkDelete: { new: true } },
            });
          });

          if (voucher.voucherType === "Sales" && !voucher.optional) {
            intercompanyDatesToRecalc.add(voucher.voucherDate);
          }
          deletedCount++;
        } catch (err: unknown) {
          errors.push(`Failed to delete voucher ${id}: ${getErrorMessage(err)}`);
        }
      }

      // Deleted cash sales must leave the intercompany POS mirror; one atomic
      // rebuild per affected date (never throws, logs on failure).
      for (const date of intercompanyDatesToRecalc) {
        await recalculateIntercompanyForDate(currentCompanyId, date);
      }

      res.json({
        message: `Deleted ${deletedCount} voucher(s)`,
        deletedCount,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error: unknown) {
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  // Fiscal Period Closing
  // Close a fiscal period (Admin/Owner only)
}
