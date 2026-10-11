/**
 * balanceRepairRoutes: BalanceRepairScan endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { propertyMonthlyLedger, propertyContracts, propertyUnits } from "../../../shared/schema";
import { eq, sql } from "drizzle-orm";

import {
  DepositFlagMismatch,
  LedgerDrift,
  OrphanedTransfer,
  ScanResult,
  VoucherEntryMissing,
  parseNum,
} from "./_helpers";
import { resultRows } from "../../lib/queryResult";

export function registerBalanceRepairScanRoutes(app: Express) {
  // ── GET /api/admin/repair-balances/scan ──────────────────────────────────
  app.get("/api/admin/repair-balances/scan", requireAuth, requireRole("Admin"), async (req: Request, res: Response) => {
    try {
      const companyId: number | undefined = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // ── 1. Ledger drift: paid_amount vs sum of property_payments ─────────
      const allLedger = await db
        .select()
        .from(propertyMonthlyLedger)
        .where(eq(propertyMonthlyLedger.companyId, companyId));

      const pmtSumsRows = await db.execute(sql`
          SELECT ledger_row_id, COALESCE(SUM(amount::numeric), 0) AS total_paid
          FROM property_payments
          WHERE company_id = ${companyId} AND ledger_row_id IS NOT NULL
          GROUP BY ledger_row_id
        `);
      const pmtMap = new Map<number, number>();
      for (const row of resultRows(pmtSumsRows)) {
        pmtMap.set(Number(row.ledger_row_id), parseNum(row.total_paid));
      }

      // Load contract + unit info for labels
      const contracts = await db.select().from(propertyContracts).where(eq(propertyContracts.companyId, companyId));
      const contractMap = new Map(contracts.map((c) => [c.id, c]));

      const allUnits = await db
        .select({
          id: propertyUnits.id,
          locationGroup: propertyUnits.locationGroup,
          unitNumber: propertyUnits.unitNumber,
          unitType: propertyUnits.unitType,
        })
        .from(propertyUnits)
        .where(eq(propertyUnits.companyId, companyId));
      const unitMap = new Map(allUnits.map((u) => [u.id, u]));

      const ledgerDrifts: LedgerDrift[] = [];
      for (const row of allLedger) {
        const computed = pmtMap.get(row.id) ?? 0;
        const stored = parseNum(row.paidAmount);
        const diff = Math.abs(computed - stored);
        if (diff > 0.005) {
          const contract = contractMap.get(row.contractId);
          const unit = unitMap.get(row.unitId ?? contract?.unitId ?? 0);
          ledgerDrifts.push({
            id: row.id,
            contractId: row.contractId,
            year: row.year,
            month: row.month,
            module: row.module ?? "PROPERTIES",
            tenantName: contract?.tenantName ?? `Contract #${row.contractId}`,
            unitLabel: unit ? `${unit.locationGroup}/${unit.unitNumber}` : `Unit#${row.unitId}`,
            storedPaid: stored,
            computedPaid: computed,
            diff,
          });
        }
      }

      // ── 2. Rent voucher entry missing: payment has voucher_id but entries absent/voucher soft-deleted ──
      const paymentsWithVoucher = await db.execute(sql`
          SELECT
            pp.id          AS payment_id,
            pp.voucher_id,
            pp.contract_id,
            pp.module,
            pp.amount,
            pp.payment_date,
            pp.cash_account_id,
            pp.unit_id,
            v.deleted_at   AS voucher_deleted_at,
            (SELECT COUNT(*) FROM voucher_entries ve WHERE ve.voucher_id = pp.voucher_id) AS entry_count,
            la.name        AS cash_account_name,
            pu.unit_type
          FROM property_payments pp
          JOIN vouchers v ON v.id = pp.voucher_id
          LEFT JOIN ledger_accounts la ON la.id = pp.cash_account_id
          LEFT JOIN property_units pu ON pu.id = pp.unit_id
          WHERE pp.company_id = ${companyId}
            AND pp.voucher_id IS NOT NULL
        `);

      const voucherEntryMissing: VoucherEntryMissing[] = [];
      const seenVoucherIds = new Set<number>(); // deduplicate (split payments share one voucher)
      for (const row of resultRows<{
        payment_id: number;
        voucher_id: number;
        contract_id: number;
        unit_id: number | null;
        module: string | null;
        amount: string | null;
        payment_date: string;
        entry_count: string | number | null;
        voucher_deleted_at: string | null;
        cash_account_id: number | null;
        cash_account_name: string | null;
        unit_type: string | null;
      }>(paymentsWithVoucher)) {
        const vid = Number(row.voucher_id);
        if (seenVoucherIds.has(vid)) continue;
        const entryCount = Number(row.entry_count ?? 0);
        const isDeleted = !!row.voucher_deleted_at;
        if (entryCount === 0 || isDeleted) {
          seenVoucherIds.add(vid);
          const contract = contractMap.get(Number(row.contract_id));
          const unit = unitMap.get(Number(row.unit_id));
          voucherEntryMissing.push({
            paymentId: Number(row.payment_id),
            voucherId: vid,
            contractId: Number(row.contract_id),
            module: row.module ?? "PROPERTIES",
            tenantName: contract?.tenantName ?? `Contract #${row.contract_id}`,
            unitLabel: unit ? `${unit.locationGroup}/${unit.unitNumber}` : `Unit#${row.unit_id}`,
            amount: parseNum(row.amount),
            paymentDate: row.payment_date,
            cashAccountId: row.cash_account_id ? Number(row.cash_account_id) : null,
            cashAccountName: row.cash_account_name ?? "(unknown account)",
            unitType: row.unit_type ?? "WAREHOUSE",
            issue: isDeleted ? "SOFT_DELETED_VOUCHER" : "EMPTY_VOUCHER",
          });
        }
      }

      // ── 3. Orphaned inter-company transfer sides ──────────────────────────
      // A transfer is orphaned if one of its vouchers is soft-deleted OR has no entries,
      // while the other side still exists and has entries.
      const transferRows = await db.execute(sql`
          SELECT
            ict.id,
            ict.description,
            ict.amount,
            ict.transfer_date,
            ict.from_company_id,
            ict.to_company_id,
            ict.from_voucher_id,
            ict.to_voucher_id,
            fc.name AS from_company_name,
            tc.name AS to_company_name,
            fv.deleted_at AS from_deleted,
            tv.deleted_at AS to_deleted,
            (SELECT COUNT(*) FROM voucher_entries ve WHERE ve.voucher_id = ict.from_voucher_id) AS from_entry_count,
            (SELECT COUNT(*) FROM voucher_entries ve WHERE ve.voucher_id = ict.to_voucher_id)   AS to_entry_count
          FROM inter_company_transfers ict
          LEFT JOIN companies fc ON fc.id = ict.from_company_id
          LEFT JOIN companies tc ON tc.id = ict.to_company_id
          LEFT JOIN vouchers fv ON fv.id = ict.from_voucher_id
          LEFT JOIN vouchers tv ON tv.id = ict.to_voucher_id
          WHERE (ict.from_company_id = ${companyId} OR ict.to_company_id = ${companyId})
            AND ict.deleted_at IS NULL
        `);

      const orphanedTransfers: OrphanedTransfer[] = [];
      for (const row of resultRows<{
        id: number;
        description: string | null;
        amount: string | null;
        transfer_date: string;
        from_company_id: number;
        to_company_id: number;
        from_voucher_id: number | null;
        to_voucher_id: number | null;
        from_company_name: string | null;
        to_company_name: string | null;
        from_deleted: string | null;
        to_deleted: string | null;
        from_entry_count: string | number | null;
        to_entry_count: string | number | null;
      }>(transferRows)) {
        const fromBroken = !!row.from_deleted || Number(row.from_entry_count ?? 0) === 0;
        const toBroken = !!row.to_deleted || Number(row.to_entry_count ?? 0) === 0;
        const fromExists = !!row.from_voucher_id;
        const toExists = !!row.to_voucher_id;

        // One side broken, the other fine = orphan
        if (fromBroken && toExists && !toBroken) {
          orphanedTransfers.push({
            transferId: Number(row.id),
            description: row.description ?? "",
            amount: parseNum(row.amount),
            transferDate: row.transfer_date,
            fromCompanyName: row.from_company_name ?? `Company #${row.from_company_id}`,
            toCompanyName: row.to_company_name ?? `Company #${row.to_company_id}`,
            orphanedSide: "FROM",
            orphanedVoucherId: Number(row.from_voucher_id),
            issue: row.from_deleted ? "SOFT_DELETED" : "EMPTY_ENTRIES",
          });
        } else if (toBroken && fromExists && !fromBroken) {
          orphanedTransfers.push({
            transferId: Number(row.id),
            description: row.description ?? "",
            amount: parseNum(row.amount),
            transferDate: row.transfer_date,
            fromCompanyName: row.from_company_name ?? `Company #${row.from_company_id}`,
            toCompanyName: row.to_company_name ?? `Company #${row.to_company_id}`,
            orphanedSide: "TO",
            orphanedVoucherId: Number(row.to_voucher_id),
            issue: row.to_deleted ? "SOFT_DELETED" : "EMPTY_ENTRIES",
          });
        }
      }

      // ── 4. Deposit flag mismatches ────────────────────────────────────────
      const guarRows = await db.execute(sql`
          SELECT voucher_number, total_amount FROM vouchers
          WHERE company_id = ${companyId} AND deleted_at IS NULL AND voucher_number LIKE 'GUAR-%'
        `);
      const guarContractIds = new Set<number>();
      const guarAmountMap = new Map<number, number>(); // contractId → voucher total_amount
      for (const row of resultRows(guarRows)) {
        const parts = String(row.voucher_number ?? "").split("-");
        const cid = parseInt(parts[parts.length - 1]);
        if (!isNaN(cid)) {
          guarContractIds.add(cid);
          guarAmountMap.set(cid, parseNum(row.total_amount));
        }
      }

      const depositFlagMismatches: DepositFlagMismatch[] = [];
      for (const c of contracts) {
        const gAmt = parseNum(c.guaranteeAmount);
        const flagOn = c.guaranteePostedToStatement;
        const hasVouc = guarContractIds.has(c.id);
        const unit = unitMap.get(c.unitId);
        const postedAmt = parseNum(c.guaranteePostedAmount ?? String(gAmt));
        const voucherAmt = guarAmountMap.get(c.id) ?? 0;

        if (flagOn && !hasVouc) {
          // Flag says posted but no accounting entry exists — shows green in UI but missing from balance sheet
          depositFlagMismatches.push({
            contractId: c.id,
            tenantName: c.tenantName,
            unitLabel: unit ? `${unit.locationGroup}/${unit.unitNumber}` : `Unit#${c.unitId}`,
            module: c.module,
            guaranteeAmount: postedAmt,
            flagValue: true,
            voucherExists: false,
            issue: "STALE_FLAG",
          });
        } else if (!flagOn && hasVouc && gAmt > 0) {
          // Voucher exists and has accounting entries, but flag is still false — UI shows unposted incorrectly
          depositFlagMismatches.push({
            contractId: c.id,
            tenantName: c.tenantName,
            unitLabel: unit ? `${unit.locationGroup}/${unit.unitNumber}` : `Unit#${c.unitId}`,
            module: c.module,
            guaranteeAmount: gAmt,
            flagValue: false,
            voucherExists: true,
            issue: "MISSING_FLAG",
          });
        } else if (flagOn && hasVouc && Math.abs(voucherAmt - postedAmt) > 0.01) {
          // Flag and voucher both exist, but recorded amount on contract differs from actual voucher amount
          depositFlagMismatches.push({
            contractId: c.id,
            tenantName: c.tenantName,
            unitLabel: unit ? `${unit.locationGroup}/${unit.unitNumber}` : `Unit#${c.unitId}`,
            module: c.module,
            guaranteeAmount: postedAmt,
            voucherAmount: voucherAmt,
            flagValue: true,
            voucherExists: true,
            issue: "AMOUNT_MISMATCH",
          });
        }
      }

      const result: ScanResult = {
        ledgerDrifts,
        voucherEntryMissing,
        orphanedTransfers,
        depositFlagMismatches,
        totalDiscrepancies:
          ledgerDrifts.length + voucherEntryMissing.length + orphanedTransfers.length + depositFlagMismatches.length,
      };
      res.json(result);
    } catch (err: unknown) {
      logger.error("[BalanceRepair] scan error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
