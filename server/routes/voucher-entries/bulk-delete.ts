/**
 * voucherEntryRoutes: VoucherBulkDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import {
  logAudit,
  syncEmployeeBalancesFromEntries,
  snapshotVoucherEntries,
  buildVoucherChangesForDelete,
} from "../_helpers";
import {
  stockTransferVouchers,
  stockTransferItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  vouchers,
  voucherEntries,
  salesItems,
  interCompanyTransfers,
  creditNoteItems,
  salaryAdvances,
  salaryAdvanceDeductions,
  propertyPayments,
  erpPayrollRuns,
  erpPayrollRunItems,
  intercompanyPaymentRequests,
} from "@shared/schema";
import { eq, and, or, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { adjustInventory } from "../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

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
            // IMPORTANT: Reverse inventory movements for Stock Transfer vouchers
            if (
              voucher.voucherType === "Stock Transfer" ||
              voucher.voucherType === "StockTransfer" ||
              voucher.voucherType === "Transfer"
            ) {
              const [transferVoucher] = await tx
                .select()
                .from(stockTransferVouchers)
                .where(eq(stockTransferVouchers.voucherId, id))
                .limit(1);

              // Reverse inventory if: inventory was explicitly applied (inventoryApplied=true)
              // OR voucher is non-optional (legacy behaviour before inventoryApplied column existed).
              if (transferVoucher && (transferVoucher.inventoryApplied || !voucher.optional)) {
                const transferItemsList = await tx
                  .select()
                  .from(stockTransferItems)
                  .where(eq(stockTransferItems.transferId, transferVoucher.id));

                for (const item of transferItemsList) {
                  const qty = parseFloat(item.quantity);
                  const transferRate = parseFloat(item.rate);
                  // Use per-item sourceLocationId (multi-source transfers may differ per item)
                  const itemSourceId = item.sourceLocationId || transferVoucher.sourceLocationId!;

                  // Add back to source location (reverse the deduction)
                  await adjustInventory(tx, itemSourceId, item.stockItemId, qty, currentCompanyId, transferRate);

                  // Remove from destination location (reverse the addition)
                  await adjustInventory(
                    tx,
                    transferVoucher.destinationLocationId!,
                    item.stockItemId,
                    -qty,
                    currentCompanyId
                  );

                  await postStockMovementTx(
                    tx,
                    {
                      companyId: currentCompanyId,
                      stockItemId: item.stockItemId,
                      kind: "transfer",
                      quantity: String(qty),
                      unitCost: String(Math.max(transferRate || 0, 0)),
                      fromLocationId: transferVoucher.destinationLocationId!,
                      toLocationId: itemSourceId,
                      occurredAt,
                      source: {
                        sourceType: "bulk_voucher_delete_stock_transfer",
                        sourceId: String(id),
                        idempotencyKey: `bulk-voucher-delete:transfer:${currentCompanyId}:${id}:${item.id}`,
                      },
                      actor: {
                        userId: req.session.userId,
                        username: req.session.username,
                        reason: `Bulk delete voucher ${voucher.voucherNumber}`,
                      },
                      allowNegativeStock: true,
                    },
                    canonicalStockMovementAdapter
                  );
                }
              }

              if (transferVoucher) {
                await tx.delete(stockTransferItems).where(eq(stockTransferItems.transferId, transferVoucher.id));
                await tx.delete(stockTransferVouchers).where(eq(stockTransferVouchers.id, transferVoucher.id));
              }
            }

            // IMPORTANT: Reverse inventory movements for Stock Adjustment (Production/Consumption/Mixed) vouchers
            if (
              (voucher.voucherType === "Production" ||
                voucher.voucherType === "Consumption" ||
                voucher.voucherType === "Mixed") &&
              !voucher.optional
            ) {
              const [adjustmentVoucher] = await tx
                .select()
                .from(stockAdjustmentVouchers)
                .where(eq(stockAdjustmentVouchers.voucherId, id))
                .limit(1);

              if (adjustmentVoucher) {
                const adjustmentItemsList = await tx
                  .select()
                  .from(stockAdjustmentItems)
                  .where(eq(stockAdjustmentItems.adjustmentId, adjustmentVoucher.id));

                for (const item of adjustmentItemsList) {
                  const qty = parseFloat(item.quantity);
                  const adjustmentRate = parseFloat(item.rate);
                  const absoluteQty = Math.abs(qty);
                  // `adjustment_type` is stored in both casings: createStockAdjustment
                  // writes "Production"/"Consumption"/"Mixed" while the
                  // PATCH /api/vouchers/:id/adjustment path writes them lowercased.
                  // Comparing case-sensitively here classified a lowercase
                  // "production" row as consumption and ADDED its quantity back on
                  // delete instead of subtracting it, inflating stock by twice the
                  // adjusted quantity. Normalise, as import-cycle/balance.ts and
                  // ledger/initialize-balances.ts already do for the same column.
                  const normalisedAdjustmentType = (adjustmentVoucher.adjustmentType || "").toLowerCase();
                  const isProduction =
                    normalisedAdjustmentType === "production" || (normalisedAdjustmentType === "mixed" && qty > 0);

                  if (isProduction) {
                    // Production added inventory, so reverse by subtracting
                    const result = await adjustInventory(
                      tx,
                      adjustmentVoucher.locationId,
                      item.stockItemId,
                      -absoluteQty,
                      currentCompanyId
                    );
                    await postStockMovementTx(
                      tx,
                      {
                        companyId: currentCompanyId,
                        stockItemId: item.stockItemId,
                        kind: "adjustment",
                        quantity: String(absoluteQty),
                        unitCost: String(Math.max(adjustmentRate || result.averageRate || 0, 0)),
                        fromLocationId: adjustmentVoucher.locationId,
                        occurredAt,
                        source: {
                          sourceType: "bulk_voucher_delete_stock_adjustment",
                          sourceId: String(id),
                          idempotencyKey: `bulk-voucher-delete:adjustment:${currentCompanyId}:${id}:${item.id}`,
                        },
                        actor: {
                          userId: req.session.userId,
                          username: req.session.username,
                          reason: `Bulk delete voucher ${voucher.voucherNumber}`,
                        },
                        allowNegativeStock: true,
                      },
                      canonicalStockMovementAdapter
                    );
                  } else {
                    // Consumption subtracted inventory, so reverse by adding back
                    await adjustInventory(
                      tx,
                      adjustmentVoucher.locationId,
                      item.stockItemId,
                      absoluteQty,
                      currentCompanyId,
                      adjustmentRate
                    );
                    await postStockMovementTx(
                      tx,
                      {
                        companyId: currentCompanyId,
                        stockItemId: item.stockItemId,
                        kind: "adjustment",
                        quantity: String(absoluteQty),
                        unitCost: String(Math.max(adjustmentRate || 0, 0)),
                        toLocationId: adjustmentVoucher.locationId,
                        occurredAt,
                        source: {
                          sourceType: "bulk_voucher_delete_stock_adjustment",
                          sourceId: String(id),
                          idempotencyKey: `bulk-voucher-delete:adjustment:${currentCompanyId}:${id}:${item.id}`,
                        },
                        actor: {
                          userId: req.session.userId,
                          username: req.session.username,
                          reason: `Bulk delete voucher ${voucher.voucherNumber}`,
                        },
                      },
                      canonicalStockMovementAdapter
                    );
                  }
                }

                await tx
                  .delete(stockAdjustmentItems)
                  .where(eq(stockAdjustmentItems.adjustmentId, adjustmentVoucher.id));
                await tx.delete(stockAdjustmentVouchers).where(eq(stockAdjustmentVouchers.id, adjustmentVoucher.id));
              }
            }

            // IMPORTANT: Reverse inventory movements for POS Sales vouchers (Receipt/Sales with sales items)
            if ((voucher.voucherType === "Receipt" || voucher.voucherType === "Sales") && !voucher.optional) {
              const saleItems = await tx.select().from(salesItems).where(eq(salesItems.voucherId, id));

              if (saleItems.length > 0) {
                // Only reverse inventory if we have a definite location from the voucher
                if (voucher.locationId) {
                  for (const item of saleItems) {
                    const qty = parseFloat(item.quantity);
                    const costPrice = parseFloat(item.costPrice || "0");

                    // Add back sold items to inventory (reverse the sale deduction)
                    const result = await adjustInventory(
                      tx,
                      voucher.locationId,
                      item.stockItemId,
                      qty,
                      currentCompanyId,
                      costPrice
                    );
                    await postStockMovementTx(
                      tx,
                      {
                        companyId: currentCompanyId,
                        stockItemId: item.stockItemId,
                        kind: "adjustment",
                        quantity: String(qty),
                        unitCost: String(Math.max(costPrice || result.averageRate || 0, 0)),
                        toLocationId: voucher.locationId,
                        occurredAt,
                        source: {
                          sourceType: "bulk_voucher_delete_pos_sale",
                          sourceId: String(id),
                          idempotencyKey: `bulk-voucher-delete:pos:${currentCompanyId}:${id}:${item.id}`,
                        },
                        actor: {
                          userId: req.session.userId,
                          username: req.session.username,
                          reason: `Bulk delete voucher ${voucher.voucherNumber}`,
                        },
                      },
                      canonicalStockMovementAdapter
                    );
                  }
                }

                // Delete sales items regardless of whether inventory was reversed
                await tx.delete(salesItems).where(eq(salesItems.voucherId, id));
              }
            }

            // IMPORTANT: Reverse inventory movements for Credit Note / Debit Note vouchers
            if ((voucher.voucherType === "Credit Note" || voucher.voucherType === "Debit Note") && !voucher.optional) {
              const noteItems = await tx.select().from(creditNoteItems).where(eq(creditNoteItems.voucherId, id));

              if (noteItems.length > 0) {
                logger.info(
                  `[Bulk Delete Credit/Debit Note] Voucher ${id}: Found ${noteItems.length} items to reverse`
                );

                for (const item of noteItems) {
                  const qty = parseFloat(item.quantity);
                  const inventoryCost = parseFloat(item.inventoryCost || item.rate || "0");

                  if (voucher.voucherType === "Credit Note") {
                    // Credit Note forward: added qty to inventory
                    // Reversal: subtract qty from inventory
                    const result = await adjustInventory(tx, item.locationId, item.stockItemId, -qty, currentCompanyId);
                    await postStockMovementTx(
                      tx,
                      {
                        companyId: currentCompanyId,
                        stockItemId: item.stockItemId,
                        kind: "adjustment",
                        quantity: String(qty),
                        unitCost: String(Math.max(inventoryCost || result.averageRate || 0, 0)),
                        fromLocationId: item.locationId,
                        occurredAt,
                        source: {
                          sourceType: "bulk_voucher_delete_credit_note",
                          sourceId: String(id),
                          idempotencyKey: `bulk-voucher-delete:credit-note:${currentCompanyId}:${id}:${item.id}`,
                        },
                        actor: {
                          userId: req.session.userId,
                          username: req.session.username,
                          reason: `Bulk delete voucher ${voucher.voucherNumber}`,
                        },
                        allowNegativeStock: true,
                      },
                      canonicalStockMovementAdapter
                    );
                  } else {
                    // Debit Note forward: removed qty from inventory
                    // Reversal: add qty back to inventory
                    const result = await adjustInventory(
                      tx,
                      item.locationId,
                      item.stockItemId,
                      qty,
                      currentCompanyId,
                      inventoryCost
                    );
                    await postStockMovementTx(
                      tx,
                      {
                        companyId: currentCompanyId,
                        stockItemId: item.stockItemId,
                        kind: "adjustment",
                        quantity: String(qty),
                        unitCost: String(Math.max(inventoryCost || result.averageRate || 0, 0)),
                        toLocationId: item.locationId,
                        occurredAt,
                        source: {
                          sourceType: "bulk_voucher_delete_debit_note",
                          sourceId: String(id),
                          idempotencyKey: `bulk-voucher-delete:debit-note:${currentCompanyId}:${id}:${item.id}`,
                        },
                        actor: {
                          userId: req.session.userId,
                          username: req.session.username,
                          reason: `Bulk delete voucher ${voucher.voucherNumber}`,
                        },
                      },
                      canonicalStockMovementAdapter
                    );
                  }
                }

                // Delete the credit note items
                await tx.delete(creditNoteItems).where(eq(creditNoteItems.voucherId, id));
              }
            }

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
                true // reverse
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
            // also delete the OTHER side's entries + voucher and the transfer record,
            // so both companies' books are fully clean.
            const linkedTransfers = await tx
              .select()
              .from(interCompanyTransfers)
              .where(or(eq(interCompanyTransfers.fromVoucherId, id), eq(interCompanyTransfers.toVoucherId, id)));
            for (const transfer of linkedTransfers) {
              const otherVoucherId = transfer.fromVoucherId === id ? transfer.toVoucherId : transfer.fromVoucherId;
              // Delete the transfer record FIRST to release FK "restrict" constraints
              // on fromVoucherId / toVoucherId before hard-deleting those voucher rows.
              await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, transfer.id));
              if (otherVoucherId && otherVoucherId !== id) {
                await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, otherVoucherId));
                await tx.delete(vouchers).where(eq(vouchers.id, otherVoucherId));
              }
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
                    if (parseFloat(item.deduction || "0") <= 0 || !item.employeeId) continue;
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
                      const dedAmt = parseFloat(ded.deductionAmount || "0");
                      const [adv] = await tx
                        .select()
                        .from(salaryAdvances)
                        .where(eq(salaryAdvances.id, ded.salaryAdvanceId));
                      if (!adv) continue;
                      const newBal = Math.min(
                        parseFloat(adv.remainingBalance || "0") + dedAmt,
                        parseFloat(adv.amount || "0")
                      );
                      await tx
                        .update(salaryAdvances)
                        .set({ remainingBalance: newBal.toFixed(2), fullyPaid: false })
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
          });

          // Log the deletion to audit log
          const _bulkEntries = await storage.getVoucherEntriesByVoucher(id).catch(() => []);
          const _bulkEntriesSnap = await snapshotVoucherEntries(_bulkEntries).catch(() => []);
          await logAudit({
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: req.session.currentCompanyId!,
            action: "delete",
            tableName: "vouchers",
            recordId: id,
            recordIdentifier: voucher.voucherNumber,
            changes: buildVoucherChangesForDelete(voucher, _bulkEntriesSnap),
          });

          deletedCount++;
        } catch (err: unknown) {
          errors.push(`Failed to delete voucher ${id}: ${getErrorMessage(err)}`);
        }
      }

      res.json({
        message: `Deleted ${deletedCount} voucher(s)`,
        deletedCount,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Fiscal Period Closing
  // Close a fiscal period (Admin/Owner only)
}
