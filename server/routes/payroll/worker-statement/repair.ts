/**
 * workerStatementRoutes: OrphanedVoucherRepair endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, sql, inArray } from "drizzle-orm";
import {
  factoryPayrolls,
  factoryWorkerAdvances,
  factoryAdvanceRepayments,
  vouchers,
  voucherEntries,
} from "@shared/schema";

import { getFactoryCompanyId } from "./_helpers";

export function registerOrphanedVoucherRepairRoutes(app: Express) {
  // POST /api/factory/repair-orphaned-vouchers
  // Finds and deletes vouchers that were created for payroll/advance events that have
  // since been undone or deleted, leaving stale ledger entries (wrong cash balance etc).
  app.post("/api/factory/repair-orphaned-vouchers", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentRole = req.session.currentRole;
      if (!["Admin", "Owner", "Developer"].includes(currentRole ?? "")) {
        return res.status(403).json({ message: "Only Admin, Owner, or Developer can run ledger repair" });
      }
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      let deletedPayrollVouchers = 0;
      let deletedAdvanceVouchers = 0;

      await db.transaction(async (tx) => {
        // ── PAYMENT-PAY-{payrollId}-{ts} ────────────────────────────────────────
        // Should exist only when the referenced payroll is in PAID status.
        // If the payroll is DRAFT, APPROVED, or deleted → the voucher is orphaned.
        const payVouchers = await tx
          .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber })
          .from(vouchers)
          .where(and(eq(vouchers.companyId, companyId), sql`${vouchers.voucherNumber} LIKE 'PAYMENT-PAY-%'`));

        const orphanedPayVoucherIds: number[] = [];
        for (const v of payVouchers) {
          const parts = v.voucherNumber.split("-");
          const payrollId = parseInt(parts[2]);
          if (!payrollId || isNaN(payrollId)) {
            orphanedPayVoucherIds.push(v.id);
            continue;
          }
          const [payroll] = await tx
            .select({ status: factoryPayrolls.status })
            .from(factoryPayrolls)
            .where(and(eq(factoryPayrolls.id, payrollId), eq(factoryPayrolls.companyId, companyId)));
          if (!payroll || payroll.status !== "PAID") {
            orphanedPayVoucherIds.push(v.id);
          }
        }

        if (orphanedPayVoucherIds.length > 0) {
          await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, orphanedPayVoucherIds));
          await tx.delete(vouchers).where(inArray(vouchers.id, orphanedPayVoucherIds));
          deletedPayrollVouchers = orphanedPayVoucherIds.length;
        }

        // ── PAYMENT-ADV-{advanceId}-{ts} ────────────────────────────────────────
        // Should exist only when the referenced advance still exists in the table.
        // If the advance was deleted → the voucher is orphaned.
        const advVouchers = await tx
          .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber })
          .from(vouchers)
          .where(and(eq(vouchers.companyId, companyId), sql`${vouchers.voucherNumber} LIKE 'PAYMENT-ADV-%'`));

        const orphanedAdvVoucherIds: number[] = [];
        for (const v of advVouchers) {
          const parts = v.voucherNumber.split("-");
          const advanceId = parseInt(parts[2]);
          if (!advanceId || isNaN(advanceId)) {
            orphanedAdvVoucherIds.push(v.id);
            continue;
          }
          const [advance] = await tx
            .select({ id: factoryWorkerAdvances.id })
            .from(factoryWorkerAdvances)
            .where(and(eq(factoryWorkerAdvances.id, advanceId), eq(factoryWorkerAdvances.companyId, companyId)));
          if (!advance) {
            orphanedAdvVoucherIds.push(v.id);
          }
        }

        if (orphanedAdvVoucherIds.length > 0) {
          await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, orphanedAdvVoucherIds));
          await tx.delete(vouchers).where(inArray(vouchers.id, orphanedAdvVoucherIds));
          deletedAdvanceVouchers = orphanedAdvVoucherIds.length;
        }

        // ── REPAY-SAL-{repaymentId}-{ts} and RECEIPT-REPAY-{repaymentId}-{ts} ──
        // Orphaned when the repayment record was deleted (e.g. via Reverse Advance)
        // but the voucher was not removed. Clean them up now.
        let _deletedRepayVouchers = 0;
        const repayVouchers = await tx
          .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber })
          .from(vouchers)
          .where(
            and(
              eq(vouchers.companyId, companyId),
              sql`(${vouchers.voucherNumber} LIKE 'REPAY-SAL-%' OR ${vouchers.voucherNumber} LIKE 'RECEIPT-REPAY-%')`
            )
          );

        const orphanedRepayVoucherIds: number[] = [];
        for (const v of repayVouchers) {
          const m = v.voucherNumber.match(/^(?:REPAY-SAL|RECEIPT-REPAY)-(\d+)-/);
          if (!m) {
            orphanedRepayVoucherIds.push(v.id);
            continue;
          }
          const repaymentId = parseInt(m[1]);
          const [repayment] = await tx
            .select({ id: factoryAdvanceRepayments.id })
            .from(factoryAdvanceRepayments)
            .where(eq(factoryAdvanceRepayments.id, repaymentId));
          if (!repayment) {
            orphanedRepayVoucherIds.push(v.id);
          }
        }

        if (orphanedRepayVoucherIds.length > 0) {
          await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, orphanedRepayVoucherIds));
          await tx.delete(vouchers).where(inArray(vouchers.id, orphanedRepayVoucherIds));
          _deletedRepayVouchers = orphanedRepayVoucherIds.length;
        }

        // ── PAYROLL-GEN-{ts} ────────────────────────────────────────────────
        // A PAYROLL-GEN voucher is orphaned when no factory_payrolls rows exist
        // for the same company + periodStart (voucherDate). This happens when all
        // payrolls in a batch are deleted/undone individually and the repair
        // utility is run afterward as a safety net.
        const genVouchers = await tx
          .select({ id: vouchers.id, voucherDate: vouchers.voucherDate, description: vouchers.description })
          .from(vouchers)
          .where(and(eq(vouchers.companyId, companyId), sql`${vouchers.voucherNumber} LIKE 'PAYROLL-GEN-%'`));

        const orphanedGenVoucherIds: number[] = [];
        for (const v of genVouchers) {
          // Parse periodEnd from description: "Payroll expense: N workers (YYYY-MM-DD – YYYY-MM-DD)"
          const periodMatch = (v.description as string | null)?.match(
            /\((\d{4}-\d{2}-\d{2})\s*[–-]\s*(\d{4}-\d{2}-\d{2})\)/
          );
          const periodStart = v.voucherDate as string;
          const periodEnd = periodMatch ? periodMatch[2] : null;

          const whereConditions = [
            eq(factoryPayrolls.companyId, companyId),
            eq(factoryPayrolls.periodStart, periodStart),
          ];
          if (periodEnd) whereConditions.push(eq(factoryPayrolls.periodEnd, periodEnd));

          const [payrollExists] = await tx
            .select({ id: factoryPayrolls.id })
            .from(factoryPayrolls)
            .where(and(...whereConditions))
            .limit(1);

          if (!payrollExists) {
            orphanedGenVoucherIds.push(v.id);
          }
        }

        let _deletedGenVouchers = 0;
        if (orphanedGenVoucherIds.length > 0) {
          await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, orphanedGenVoucherIds));
          await tx.delete(vouchers).where(inArray(vouchers.id, orphanedGenVoucherIds));
          _deletedGenVouchers = orphanedGenVoucherIds.length;
        }
      });

      res.json({
        message: "Ledger repair complete",
        deletedPayrollVouchers,
        deletedAdvanceVouchers,
        total: deletedPayrollVouchers + deletedAdvanceVouchers,
      });
    } catch (error: unknown) {
      logger.error("Repair orphaned vouchers error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
