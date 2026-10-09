/**
 * balanceRepairRoutes: BalanceRepairApply endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import {
  propertyMonthlyLedger,
  propertyContracts,
  propertyUnits,
  vouchers,
  voucherEntries,
  interCompanyTransfers,
} from "../../../shared/schema";
import { eq, sql } from "drizzle-orm";

import { ApplySnapshot, findOrCreateLedgerAccount, parseNum } from "./_helpers";
import { resultRows } from "../../lib/queryResult";
import { retireVouchersTx, sessionRetirementActor } from "../../services/accounting/voucherRetirement";

export function registerBalanceRepairApplyRoutes(app: Express) {
  // ── POST /api/admin/repair-balances/apply ────────────────────────────────
  app.post(
    "/api/admin/repair-balances/apply",
    requireAuth,
    requireRole("Admin"),
    async (req: Request, res: Response) => {
      try {
        const companyId: number | undefined = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const snapshot: ApplySnapshot = {
          ledgerSnapshots: [],
          voucherEntriesAdded: [],
          vouchersUndeleted: [],
          orphanedVouchersDeleted: [],
          transfersDeleted: [],
          depositSnapshots: [],
        };

        // Re-run scan to get current state
        // ── 1. Fix ledger drift ───────────────────────────────────────────────
        const allLedger = await db
          .select()
          .from(propertyMonthlyLedger)
          .where(eq(propertyMonthlyLedger.companyId, companyId));
        const pmtSumsRows = await db.execute(sql`
          SELECT ledger_row_id, COALESCE(SUM(amount::numeric), 0) AS total_paid
          FROM property_payments WHERE company_id = ${companyId} AND ledger_row_id IS NOT NULL
          GROUP BY ledger_row_id
        `);
        const pmtMap = new Map<number, number>();
        for (const row of resultRows(pmtSumsRows)) {
          pmtMap.set(Number(row.ledger_row_id), parseNum(row.total_paid));
        }
        for (const row of allLedger) {
          const computed = pmtMap.get(row.id) ?? 0;
          const stored = parseNum(row.paidAmount);
          if (Math.abs(computed - stored) > 0.005) {
            snapshot.ledgerSnapshots.push({ id: row.id, oldPaid: stored, newPaid: computed });
            await db
              .update(propertyMonthlyLedger)
              .set({ paidAmount: computed.toFixed(2) })
              .where(eq(propertyMonthlyLedger.id, row.id));
          }
        }

        // ── 2. Fix missing voucher entries ────────────────────────────────────
        const contracts = await db.select().from(propertyContracts).where(eq(propertyContracts.companyId, companyId));
        const contractMap = new Map(contracts.map((c) => [c.id, c]));
        const allUnits = await db.select().from(propertyUnits).where(eq(propertyUnits.companyId, companyId));
        const _unitMap = new Map(allUnits.map((u) => [u.id, u]));

        const paymentsRows = await db.execute(sql`
          SELECT
            pp.id, pp.voucher_id, pp.contract_id, pp.module, pp.amount, pp.payment_date,
            pp.cash_account_id, pp.unit_id,
            v.deleted_at AS voucher_deleted_at,
            v.total_amount AS voucher_total,
            v.voucher_type,
            v.voucher_date,
            v.description AS voucher_desc,
            (SELECT COUNT(*) FROM voucher_entries ve WHERE ve.voucher_id = pp.voucher_id) AS entry_count,
            pu.unit_type
          FROM property_payments pp
          JOIN vouchers v ON v.id = pp.voucher_id
          LEFT JOIN property_units pu ON pu.id = pp.unit_id
          WHERE pp.company_id = ${companyId} AND pp.voucher_id IS NOT NULL
        `);

        const seenVouchers = new Set<number>();
        for (const row of resultRows<{
          payment_id: number;
          voucher_id: number;
          contract_id: number;
          unit_id: number | null;
          amount: string | null;
          payment_date: string;
          entry_count: string | number | null;
          voucher_deleted_at: string | null;
          cash_account_id: number | null;
          voucher_desc: string | null;
          voucher_total: string | null;
          module: string | null;
          unit_type: string | null;
        }>(paymentsRows)) {
          const vid = Number(row.voucher_id);
          if (seenVouchers.has(vid)) continue;
          const entryCount = Number(row.entry_count ?? 0);
          const isDeleted = !!row.voucher_deleted_at;
          if (entryCount > 0 && !isDeleted) continue;
          seenVouchers.add(vid);

          const cashAccId = row.cash_account_id ? Number(row.cash_account_id) : null;
          const amount = row.voucher_total ?? row.amount;
          const isShop = (row.unit_type ?? "WAREHOUSE") === "SHOP";
          const _contract = contractMap.get(Number(row.contract_id));
          const module = row.module ?? "PROPERTIES";

          // If voucher was soft-deleted, un-delete it first
          if (isDeleted) {
            snapshot.vouchersUndeleted.push({ id: vid });
            await db.execute(sql`UPDATE vouchers SET deleted_at = NULL WHERE id = ${vid}`);
          }

          // Re-insert entries only if there are none (after potential un-delete)
          const countAfter = await db.execute(
            sql`SELECT COUNT(*) AS cnt FROM voucher_entries WHERE voucher_id = ${vid}`
          );
          const cnt = Number(resultRows(countAfter)[0]?.cnt ?? 0);
          if (cnt === 0 && cashAccId) {
            const amtStr = String(amount);
            let incomeOrExpenseId: number | null = null;

            if (isShop) {
              incomeOrExpenseId = await findOrCreateLedgerAccount(
                companyId,
                "Rent Expense - Shops",
                "Indirect Expense",
                "SHOP-RENT-EXP"
              );
            } else {
              // Pick income account name matching the module
              const incomeAccName =
                module === "ERP"
                  ? "Rent Income - ERP"
                  : module === "FACTORY"
                    ? "Rent Income - Factory"
                    : "Rental Income";
              incomeOrExpenseId = await findOrCreateLedgerAccount(
                companyId,
                incomeAccName,
                "Income",
                "RENT-INC",
                "Indirect Income"
              );
            }

            const narration = row.voucher_desc ?? (isShop ? `Rent paid` : `Rent received`);
            let inserted: { id: number }[];
            if (isShop) {
              // Debit: expense, Credit: cash
              inserted = await db
                .insert(voucherEntries)
                .values([
                  {
                    voucherId: vid,
                    ledgerAccountId: incomeOrExpenseId!,
                    debitAmount: amtStr,
                    creditAmount: "0",
                    narration,
                  },
                  { voucherId: vid, ledgerAccountId: cashAccId, debitAmount: "0", creditAmount: amtStr, narration },
                ])
                .returning({ id: voucherEntries.id });
            } else {
              // Debit: cash, Credit: income
              inserted = await db
                .insert(voucherEntries)
                .values([
                  { voucherId: vid, ledgerAccountId: cashAccId, debitAmount: amtStr, creditAmount: "0", narration },
                  {
                    voucherId: vid,
                    ledgerAccountId: incomeOrExpenseId!,
                    debitAmount: "0",
                    creditAmount: amtStr,
                    narration,
                  },
                ])
                .returning({ id: voucherEntries.id });
            }
            snapshot.voucherEntriesAdded.push(...inserted.map((r) => r.id));
          }
        }

        // ── 3. Fix orphaned transfer sides ────────────────────────────────────
        // Delete the orphaned voucher (and its entries) and the transfer link.
        const transferRows = await db.execute(sql`
          SELECT
            ict.id, ict.transfer_type, ict.from_company_id, ict.to_company_id,
            ict.transfer_date, ict.amount, ict.from_ledger_account_id, ict.to_ledger_account_id,
            ict.from_voucher_id, ict.to_voucher_id, ict.description, ict.source_payment_id,
            fv.deleted_at AS from_deleted,
            tv.deleted_at AS to_deleted,
            (SELECT COUNT(*) FROM voucher_entries ve WHERE ve.voucher_id = ict.from_voucher_id) AS from_entry_count,
            (SELECT COUNT(*) FROM voucher_entries ve WHERE ve.voucher_id = ict.to_voucher_id)   AS to_entry_count
          FROM inter_company_transfers ict
          LEFT JOIN vouchers fv ON fv.id = ict.from_voucher_id
          LEFT JOIN vouchers tv ON tv.id = ict.to_voucher_id
          WHERE ict.from_company_id = ${companyId} OR ict.to_company_id = ${companyId}
        `);

        for (const row of resultRows<{
          id: number;
          transfer_type: string;
          from_company_id: number;
          to_company_id: number;
          transfer_date: string;
          amount: string | null;
          from_ledger_account_id: number;
          to_ledger_account_id: number;
          from_voucher_id: number | null;
          to_voucher_id: number | null;
          description: string | null;
          source_payment_id: number | null;
          from_deleted: string | null;
          to_deleted: string | null;
          from_entry_count: string | number | null;
          to_entry_count: string | number | null;
        }>(transferRows)) {
          const fromBroken = !!row.from_deleted || Number(row.from_entry_count ?? 0) === 0;
          const toBroken = !!row.to_deleted || Number(row.to_entry_count ?? 0) === 0;
          const fromExists = !!row.from_voucher_id;
          const toExists = !!row.to_voucher_id;

          const isOrphaned = (fromBroken && toExists && !toBroken) || (toBroken && fromExists && !fromBroken);
          if (!isOrphaned) continue;

          // Save snapshot of the transfer record before deleting
          const transferSnap = {
            id: Number(row.id),
            transferType: row.transfer_type,
            fromCompanyId: Number(row.from_company_id),
            toCompanyId: Number(row.to_company_id),
            transferDate: row.transfer_date,
            amount: String(row.amount),
            fromLedgerAccountId: Number(row.from_ledger_account_id),
            toLedgerAccountId: Number(row.to_ledger_account_id),
            fromVoucherId: row.from_voucher_id ? Number(row.from_voucher_id) : null,
            toVoucherId: row.to_voucher_id ? Number(row.to_voucher_id) : null,
            description: row.description ?? null,
            sourcePaymentId: row.source_payment_id ? Number(row.source_payment_id) : null,
          };

          // Save the orphaned voucher's data for undo
          const orphanedVid = fromBroken ? Number(row.from_voucher_id) : Number(row.to_voucher_id);
          const [orphVoucher] = await db.select().from(vouchers).where(eq(vouchers.id, orphanedVid));
          const orphEntries = await db.select().from(voucherEntries).where(eq(voucherEntries.voucherId, orphanedVid));

          snapshot.orphanedVouchersDeleted.push({
            id: orphanedVid,
            voucherNumber: orphVoucher?.voucherNumber ?? "",
            companyId: orphVoucher?.companyId ?? 0,
            totalAmount: String(orphVoucher?.totalAmount ?? "0"),
            voucherType: orphVoucher?.voucherType ?? "Payment",
            voucherDate: String(orphVoucher?.voucherDate ?? row.transfer_date),
            description: orphVoucher?.description ?? null,
            entries: orphEntries.map((e) => ({
              ledgerAccountId: e.ledgerAccountId,
              debitAmount: String(e.debitAmount),
              creditAmount: String(e.creditAmount),
              narration: e.narration ?? null,
            })),
          });
          snapshot.transfersDeleted.push(transferSnap);

          // Transfer row first, then the orphaned voucher. Wave 16 (A): the
          // voucher is retired (soft delete with its lines, audited, number
          // released) in the same transaction, not hard-deleted.
          await db.transaction(async (tx) => {
            await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, Number(row.id)));
            if (orphVoucher) {
              await retireVouchersTx(tx, {
                companyId: orphVoucher.companyId,
                voucherIds: [orphanedVid],
                reason: "balance-repair-orphaned-transfer-voucher",
                actor: sessionRetirementActor(req),
              });
            }
          });
        }

        // ── 4. Fix deposit flags ──────────────────────────────────────────────
        const guarRows2 = await db.execute(sql`
          SELECT voucher_number, total_amount FROM vouchers
          WHERE company_id = ${companyId} AND deleted_at IS NULL AND voucher_number LIKE 'GUAR-%'
        `);
        const guarContractIds2 = new Set<number>();
        const guarAmountMap2 = new Map<number, number>();
        for (const row of resultRows(guarRows2)) {
          const parts = String(row.voucher_number ?? "").split("-");
          const cid = parseInt(parts[parts.length - 1]);
          if (!isNaN(cid)) {
            guarContractIds2.add(cid);
            guarAmountMap2.set(cid, parseNum(row.total_amount));
          }
        }
        for (const c of contracts) {
          const gAmt = parseNum(c.guaranteeAmount);
          const flagOn = c.guaranteePostedToStatement;
          const hasVouc = guarContractIds2.has(c.id);
          const postedAmt = parseNum(c.guaranteePostedAmount ?? String(gAmt));
          const voucherAmt = guarAmountMap2.get(c.id) ?? 0;

          if (flagOn && !hasVouc) {
            // Reset flag — no voucher entry exists, UI was showing green incorrectly
            snapshot.depositSnapshots.push({
              contractId: c.id,
              oldFlag: true,
              newFlag: false,
              oldPostedAmount: postedAmt,
              newPostedAmount: 0,
            });
            await db
              .update(propertyContracts)
              .set({ guaranteePostedToStatement: false, guaranteePostedAmount: "0" })
              .where(eq(propertyContracts.id, c.id));
          } else if (!flagOn && hasVouc && gAmt > 0) {
            // Set flag — voucher exists, just the contract flag was stale
            snapshot.depositSnapshots.push({
              contractId: c.id,
              oldFlag: false,
              newFlag: true,
              oldPostedAmount: 0,
              newPostedAmount: gAmt,
            });
            await db
              .update(propertyContracts)
              .set({ guaranteePostedToStatement: true, guaranteePostedAmount: String(gAmt) })
              .where(eq(propertyContracts.id, c.id));
          } else if (flagOn && hasVouc && Math.abs(voucherAmt - postedAmt) > 0.01) {
            // Sync amount on contract to match actual voucher amount
            snapshot.depositSnapshots.push({
              contractId: c.id,
              oldFlag: true,
              newFlag: true,
              oldPostedAmount: postedAmt,
              newPostedAmount: voucherAmt,
            });
            await db
              .update(propertyContracts)
              .set({ guaranteePostedAmount: String(voucherAmt) })
              .where(eq(propertyContracts.id, c.id));
          }
        }

        res.json({
          ledgerFixed: snapshot.ledgerSnapshots.length,
          voucherEntriesFixed: seenVouchers.size,
          orphansFixed: snapshot.transfersDeleted.length,
          depositsFixed: snapshot.depositSnapshots.length,
          snapshot,
        });
      } catch (err: unknown) {
        logger.error("[BalanceRepair] apply error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );
}
