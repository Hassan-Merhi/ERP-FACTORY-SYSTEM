/**
 * balanceRepairRoutes: BalanceRepairUndo endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { propertyMonthlyLedger, propertyContracts, propertyPayments } from "../../../shared/schema";
import { eq, and, sql } from "drizzle-orm";

import { ApplySnapshot, parseNum } from "./_helpers";
import { retiredVoucherNumber } from "../../services/accounting/voucherRetirement";
import { writeAuditEvent } from "../../services/audit";

export function registerBalanceRepairUndoRoutes(app: Express) {
  // ── POST /api/admin/repair-balances/undo ────────────────────────────────
  app.post(
    "/api/admin/repair-balances/undo",
    requireAuth,
    requireRole("Admin"),
    async (req: Request, res: Response) => {
      try {
        const { snapshot } = req.body as { snapshot: ApplySnapshot };
        if (!snapshot) return res.status(400).json({ message: "No snapshot provided" });

        // 1. Revert ledger drift
        for (const s of snapshot.ledgerSnapshots ?? []) {
          await db
            .update(propertyMonthlyLedger)
            .set({ paidAmount: s.oldPaid.toFixed(2) })
            .where(eq(propertyMonthlyLedger.id, s.id));
        }

        // 2. Remove inserted voucher entries
        // 3. Re-soft-delete vouchers that were un-deleted
        // Both run in one transaction so no voucher is left half-reverted at commit.
        await db.transaction(async (tx) => {
          for (const entryId of snapshot.voucherEntriesAdded ?? []) {
            await tx.execute(sql`DELETE FROM voucher_entries WHERE id = ${entryId}`);
          }

          for (const v of snapshot.vouchersUndeleted ?? []) {
            await tx.execute(sql`UPDATE vouchers SET deleted_at = NOW() WHERE id = ${v.id}`);
          }
        });

        // 4. Restore the orphaned vouchers the apply retired. Wave 16 (A): the
        // apply soft-deletes them with their lines, so the undo clears the
        // delete and gives the number back, only for a voucher still retired
        // under the number the snapshot names. It used to insert vouchers and
        // lines from the request body.
        for (const ov of snapshot.orphanedVouchersDeleted ?? []) {
          const voucherId = Number(ov.id);
          if (!Number.isInteger(voucherId) || voucherId <= 0 || typeof ov.voucherNumber !== "string") continue;
          const voucherNumber = ov.voucherNumber;
          await db.transaction(async (tx) => {
            const restored = await tx.execute(sql`
              UPDATE vouchers SET deleted_at = NULL, voucher_number = ${voucherNumber}
               WHERE id = ${voucherId} AND deleted_at IS NOT NULL
                 AND voucher_number = ${retiredVoucherNumber(voucherNumber, voucherId)}
              RETURNING company_id
            `);
            const companyId = Number((restored.rows[0] as { company_id?: unknown } | undefined)?.company_id);
            if (!companyId) return;
            await writeAuditEvent(
              {
                userId: req.session.userId ?? "unknown",
                username: req.session.username || "unknown",
                companyId,
                action: "restore",
                tableName: "vouchers",
                recordId: voucherId,
                recordIdentifier: voucherNumber,
                changes: {
                  deletedAt: { new: null },
                  voucherNumber: { old: retiredVoucherNumber(voucherNumber, voucherId), new: voucherNumber },
                  reason: { new: "balance-repair-undo" },
                },
              },
              tx
            );
          });
        }

        // 5. Re-insert deleted inter_company_transfers rows
        for (const t of snapshot.transfersDeleted ?? []) {
          await db.execute(sql`
            INSERT INTO inter_company_transfers
              (id, transfer_type, from_company_id, to_company_id, transfer_date, amount,
               from_ledger_account_id, to_ledger_account_id, from_voucher_id, to_voucher_id,
               description, source_payment_id)
            VALUES
              (${t.id}, ${t.transferType}, ${t.fromCompanyId}, ${t.toCompanyId}, ${t.transferDate}::date, ${t.amount},
               ${t.fromLedgerAccountId}, ${t.toLedgerAccountId}, ${t.fromVoucherId}, ${t.toVoucherId},
               ${t.description}, ${t.sourcePaymentId})
            ON CONFLICT (id) DO NOTHING
          `);
        }

        // 6. Revert deposit flags
        for (const s of snapshot.depositSnapshots ?? []) {
          await db
            .update(propertyContracts)
            .set({
              guaranteePostedToStatement: s.oldFlag,
              guaranteePostedAmount: s.oldPostedAmount.toFixed(2),
            })
            .where(eq(propertyContracts.id, s.contractId));
        }

        res.json({
          ledgerRestored: (snapshot.ledgerSnapshots ?? []).length,
          entriesRemoved: (snapshot.voucherEntriesAdded ?? []).length,
          orphansRestored: (snapshot.transfersDeleted ?? []).length,
          depositsRestored: (snapshot.depositSnapshots ?? []).length,
        });
      } catch (err: unknown) {
        logger.error("[BalanceRepair] undo error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ── POST /api/properties/repair/reallocate-payments/:contractId ────────────
  // Two-phase fix:
  //   Phase A (SQL, always runs): zeros out any ledger paid_amount whose sum
  //     from linked payments doesn't match — catches ghost amounts from
  //     guarantee-to-cash releases or deleted payments.
  //   Phase B (JS, runs when rent payments exist): re-allocates each rent
  //     payment to the oldest outstanding month in date order.
  app.post(
    "/api/properties/repair/reallocate-payments/:contractId",
    requireAuth,
    requireRole("Admin"),
    async (req: Request, res: Response) => {
      try {
        const companyId: number | undefined = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const contractId = parseInt(req.params.contractId, 10);
        if (isNaN(contractId)) return res.status(400).json({ message: "Invalid contractId" });

        const [contract] = await db
          .select()
          .from(propertyContracts)
          .where(and(eq(propertyContracts.id, contractId), eq(propertyContracts.companyId, companyId)));
        if (!contract) return res.status(404).json({ message: "Contract not found" });

        // ── Phase A: SQL sync — ALWAYS runs first ────────────────────────────
        // Sets each ledger row's paid_amount to the exact sum of property_payments
        // that point to it (ledger_row_id = id).  Payments with ledger_row_id
        // IS NULL (guarantee-to-cash releases) are naturally excluded by the join
        // condition, so ghost amounts from those are zeroed out here.
        await db.execute(sql`
          UPDATE property_monthly_ledger
          SET paid_amount = COALESCE((
            SELECT SUM(pp.amount::numeric)
            FROM property_payments pp
            WHERE pp.ledger_row_id = property_monthly_ledger.id
          ), 0)
          WHERE contract_id = ${contractId}
        `);

        // ── Phase A2: remove orphaned prepaid rows ────────────────────────────
        // Delete ledger rows where expected_amount = 0 AND paid_amount = 0 —
        // these are empty "prepaid" rows left over after payments were deleted.
        await db
          .delete(propertyMonthlyLedger)
          .where(
            and(
              eq(propertyMonthlyLedger.contractId, contractId),
              eq(propertyMonthlyLedger.companyId, companyId),
              sql`${propertyMonthlyLedger.expectedAmount}::numeric = 0`,
              sql`${propertyMonthlyLedger.paidAmount}::numeric = 0`
            )
          );

        // ── Phase B: JS re-allocation ────────────────────────────────────────
        // Load all payments that are NOT guarantee-to-cash releases.
        // Guarantee-to-cash payments are identified by notes containing
        // "[Guarantee release]" or "[Guarantee applied]" — those must never
        // be treated as rent payments.  Regular rent payments that have
        // ledgerRowId = null (orphaned) are included so they get properly linked.
        const payments = await db
          .select()
          .from(propertyPayments)
          .where(
            and(
              eq(propertyPayments.contractId, contractId),
              eq(propertyPayments.companyId, companyId),
              sql`(${propertyPayments.notes} IS NULL OR (${propertyPayments.notes} NOT LIKE '%[Guarantee release]%' AND ${propertyPayments.notes} NOT LIKE '%[Guarantee applied]%'))`
            )
          )
          .orderBy(propertyPayments.paymentDate, propertyPayments.id);

        if (payments.length === 0) {
          return res.json({ fixed: 0, message: "Ledger amounts synced (no rent payments to reallocate)." });
        }

        const ledgerRows = await db
          .select()
          .from(propertyMonthlyLedger)
          .where(and(eq(propertyMonthlyLedger.contractId, contractId), eq(propertyMonthlyLedger.companyId, companyId)))
          .orderBy(propertyMonthlyLedger.year, propertyMonthlyLedger.month);

        if (ledgerRows.length === 0) {
          return res.json({ fixed: 0, message: "Ledger amounts synced (no ledger rows found)." });
        }

        // Reset ledger paidAmounts to 0 in memory, then re-fill from payments
        const ledgerMap = new Map<string, { id: number; expected: number; paid: number }>();
        for (const row of ledgerRows) {
          ledgerMap.set(`${row.year}-${row.month}`, {
            id: row.id,
            expected: parseNum(row.expectedAmount),
            paid: 0,
          });
        }

        const paymentUpdates: Array<{ id: number; forYear: number; forMonth: number; ledgerRowId: number | null }> = [];

        for (const payment of payments) {
          let remaining = parseNum(payment.amount);
          let firstAlloc = true;

          while (remaining > 0.005) {
            let target: {
              key: string;
              year: number;
              month: number;
              id: number;
              expected: number;
              paid: number;
            } | null = null;
            for (const [key, row] of ledgerMap) {
              const [y, m] = key.split("-").map(Number);
              if (row.expected - row.paid > 0.005) {
                target = { key, year: y, month: m, ...row };
                break;
              }
            }
            if (!target) break;

            const chunk = Math.min(remaining, target.expected - target.paid);
            target.paid += chunk;
            remaining = Math.round((remaining - chunk) * 100) / 100;
            ledgerMap.set(target.key, target);

            if (firstAlloc) {
              paymentUpdates.push({
                id: payment.id,
                forYear: target.year,
                forMonth: target.month,
                ledgerRowId: target.id,
              });
              firstAlloc = false;
            }
          }
        }

        let fixed = 0;
        await db.transaction(async (tx) => {
          for (const [, row] of ledgerMap) {
            await tx
              .update(propertyMonthlyLedger)
              .set({ paidAmount: row.paid.toFixed(2) })
              .where(eq(propertyMonthlyLedger.id, row.id));
          }
          for (const upd of paymentUpdates) {
            const original = payments.find((p) => p.id === upd.id);
            if (
              original &&
              (Number(original.forYear) !== upd.forYear ||
                Number(original.forMonth) !== upd.forMonth ||
                original.ledgerRowId !== upd.ledgerRowId)
            ) {
              await tx
                .update(propertyPayments)
                .set({ forYear: upd.forYear, forMonth: upd.forMonth, ledgerRowId: upd.ledgerRowId })
                .where(eq(propertyPayments.id, upd.id));
              fixed++;
            }
          }
        });

        res.json({ fixed, total: payments.length, message: `Reallocated ${fixed} payment(s) to the correct months.` });
      } catch (err: unknown) {
        logger.error("[BalanceRepair] reallocate error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );
}
