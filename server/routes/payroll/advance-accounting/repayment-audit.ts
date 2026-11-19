/**
 * advanceAccountingRoutes: AdvanceRepaymentAudit endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { factoryWorkers, factoryWorkerAdvances, factoryAdvanceRepayments, vouchers } from "@shared/schema";

import { getFactoryCompanyId } from "./_helpers";
import { toMoney } from "../../../lib/money";
import { registerAdvanceRepaymentAuditRoutesPart1 } from "./registerAdvanceRepaymentAuditRoutesPart1";

export function registerAdvanceRepaymentAuditRoutes(app: Express) {
  // GET /api/factory/advances/repayment-audit — find salary deduction advances missing cash vouchers
  app.get("/api/factory/advances/repayment-audit", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // 1. All salary_deduction advances
      const allAdvances = await db
        .select()
        .from(factoryWorkerAdvances)
        .innerJoin(factoryWorkers, eq(factoryWorkerAdvances.workerId, factoryWorkers.id))
        .where(
          and(
            eq(factoryWorkerAdvances.companyId, companyId),
            eq(factoryWorkerAdvances.repaymentType, "salary_deduction")
          )
        )
        .orderBy(desc(factoryWorkerAdvances.advanceDate));

      const advanceIds = allAdvances.map((r) => r.factory_worker_advances.id);

      // 2. All repayment records for those advances
      const repayments =
        advanceIds.length > 0
          ? await db
              .select()
              .from(factoryAdvanceRepayments)
              .where(
                and(
                  eq(factoryAdvanceRepayments.companyId, companyId),
                  inArray(factoryAdvanceRepayments.advanceId, advanceIds)
                )
              )
          : [];

      // 3. All repayment vouchers for this company (both old RECEIPT-REPAY and new REPAY-SAL patterns)
      const repayVouchers = await db
        .select({ voucherNumber: vouchers.voucherNumber })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            sql`(${vouchers.voucherNumber} LIKE 'RECEIPT-REPAY-%' OR ${vouchers.voucherNumber} LIKE 'REPAY-SAL-%')`
          )
        );

      const voucheredRepayIds = new Set<number>();
      for (const v of repayVouchers) {
        const m = v.voucherNumber.match(/^(?:RECEIPT-REPAY|REPAY-SAL)-(\d+)-/);
        if (m) voucheredRepayIds.add(parseInt(m[1]));
      }

      // 4. Build repayments map by advanceId
      const repaysByAdvId = new Map<number, typeof repayments>();
      for (const r of repayments) {
        const list = repaysByAdvId.get(r.advanceId) || [];
        list.push(r);
        repaysByAdvId.set(r.advanceId, list);
      }

      // 5. Categorize
      const auditAdvances = [];
      for (const row of allAdvances) {
        const adv = row.factory_worker_advances;
        const worker = row.factory_workers;
        const advRepays = repaysByAdvId.get(adv.id) || [];
        const isPaid = adv.fullyPaid || toMoney(adv.remainingBalance).lte("0.005");

        if (advRepays.length === 0) {
          if (isPaid) {
            auditAdvances.push({
              id: adv.id,
              workerId: adv.workerId,
              workerName: worker.fullName,
              advanceDate: adv.advanceDate,
              amount: adv.amount,
              remainingBalance: adv.remainingBalance,
              fullyPaid: adv.fullyPaid,
              caseType: "no_repayment",
              repayments: [],
              missingVoucherRepayments: [],
            });
          }
        } else {
          const missingVoucherRepays = advRepays.filter((r) => !voucheredRepayIds.has(r.id));
          if (missingVoucherRepays.length > 0) {
            auditAdvances.push({
              id: adv.id,
              workerId: adv.workerId,
              workerName: worker.fullName,
              advanceDate: adv.advanceDate,
              amount: adv.amount,
              remainingBalance: adv.remainingBalance,
              fullyPaid: adv.fullyPaid,
              caseType: "missing_voucher",
              repayments: advRepays,
              missingVoucherRepayments: missingVoucherRepays,
            });
          }
        }
      }

      res.json({
        advances: auditAdvances,
        summary: {
          total: allAdvances.length,
          ok: allAdvances.length - auditAdvances.length,
          missingVoucher: auditAdvances.filter((a) => a.caseType === "missing_voucher").length,
          noRepayment: auditAdvances.filter((a) => a.caseType === "no_repayment").length,
        },
      });
    } catch (error: unknown) {
      logger.error("Error in repayment-audit:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerAdvanceRepaymentAuditRoutesPart1(app);

  // ─── ADVANCE REPAYMENTS ─────────────────────────────────────────
}
