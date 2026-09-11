/**
 * factoryWorkerRoutes: FactoryWorkerBaleSettle endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Database } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { parseId, parseOptionalId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getClientDate } from "../../lib/dateUtils";
import { checkFactoryAdmin } from "../factory/_helpers";
import { eq, and, desc, sql, gte, lte, inArray } from "drizzle-orm";
import {
  factoryWorkers,
  factoryBales,
  factoryPayrolls,
  factoryWorkerAdvances,
  factoryAttendance,
} from "@shared/schema";

import { computeMonthlyPay, computeMonthlyPayFromAttendance, getFactoryCompanyId, writeDaybookEntry } from "./_helpers";

export function registerFactoryWorkerBaleSettleRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  // GET /api/factory/workers/:id/bales - Get bales associated with worker
  app.get("/api/factory/workers/:id/bales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { startDate, endDate } = req.query;

      const conditions = [eq(factoryBales.finalizedBy, id), eq(factoryBales.companyId, companyId)];

      if (startDate) {
        conditions.push(sql`${factoryBales.finalizedAt} >= ${startDate}::timestamp`);
      }
      if (endDate) {
        conditions.push(sql`${factoryBales.finalizedAt} <= ${endDate}::timestamp + interval '1 day'`);
      }

      const bales = await db
        .select()
        .from(factoryBales)
        .where(and(...conditions))
        .orderBy(desc(factoryBales.finalizedAt));

      res.json(bales);
    } catch (error: unknown) {
      logger.error("Error fetching worker bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/workers/:id/settle-and-end - Settlement calculation + end contract
  app.post("/api/factory/workers/:id/settle-and-end", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!checkFactoryAdmin(req, res)) return;
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { startDate, endDate, hoursWorked, dryRun, payNow, cashAccountId, skipSettlement } = req.body;

      const [worker] = await db
        .select()
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.id, id), eq(factoryWorkers.companyId, companyId)));
      if (!worker) return res.status(404).json({ message: "Worker not found" });
      if (!worker.active) return res.status(400).json({ message: "Worker contract already ended" });

      // Skip-settlement: just deactivate the worker immediately, no payroll record created
      if (skipSettlement) {
        const today = getClientDate(req);
        const endEffective = endDate || today;
        await db
          .update(factoryWorkers)
          .set({ active: false, contractEndDate: endEffective, updatedAt: new Date() })
          .where(eq(factoryWorkers.id, id));
        await writeDaybookEntry(db, {
          companyId,
          txDate: today,
          txType: "CONTRACT_ENDED",
          referenceId: id,
          referenceTable: "factory_workers",
          description: `Contract ended (no settlement) for ${worker.fullName}`,
          amountCurrency: 0,
          amountUsd: 0,
          createdBy: req.session.userId ?? undefined,
        });
        return res.json({ skipped: true, workerUpdated: true });
      }

      if (!startDate || !endDate) return res.status(400).json({ message: "startDate and endDate required" });

      const toDateStr = (v: unknown): string | null => {
        if (!v) return null;
        if (v instanceof Date) return v.toISOString().split("T")[0];
        return String(v).split("T")[0];
      };
      const workerJoinDate = toDateStr(worker.contractStartDate) || toDateStr(worker.dateJoined) || null;
      const effectiveStart = workerJoinDate && workerJoinDate > startDate ? workerJoinDate : startDate;

      if (effectiveStart > endDate && dryRun) {
        return res.json({
          earned: "0.00",
          paid: "0.00",
          advances: "0.00",
          balance: "0.00",
          effectiveStart,
          dryRun: true,
        });
      }

      // Helper functions
      const daysInPeriod = (s: string, e: string) =>
        Math.floor((new Date(e).getTime() - new Date(s).getTime()) / (1000 * 60 * 60 * 24)) + 1;
      const countWeekdays = (s: string, e: string) => {
        let count = 0;
        const cur = new Date(s);
        const end = new Date(e);
        while (cur <= end) {
          const d = cur.getDay();
          if (d !== 0 && d !== 6) count++;
          cur.setDate(cur.getDate() + 1);
        }
        return count;
      };
      const _daysInMonth = (dateStr: string) => {
        const d = new Date(dateStr);
        return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      };

      const days = daysInPeriod(effectiveStart, endDate);
      const weekdays = countWeekdays(effectiveStart, endDate);
      const baseSal = parseFloat(worker.baseSalary || "0");
      const payFreq = worker.payFrequency || "Monthly";
      const salType = worker.salaryType || "Monthly";

      let earned = 0;
      const validRange = effectiveStart <= endDate;

      // Time-based frequencies use payFrequency field; production-based fall back to salaryType
      if (!validRange) {
        earned = 0;
      } else if (payFreq === "Hourly") {
        earned = (parseFloat(hoursWorked) || 0) * parseFloat(worker.hourlyRate || "0");
      } else if (payFreq === "Weekly") {
        earned = (days / 7) * parseFloat(worker.weeklySalary || "0");
      } else if (payFreq === "Bi-Weekly") {
        earned = (days / 14) * parseFloat(worker.biWeeklySalary || "0");
      } else if (salType === "Daily") {
        earned = weekdays * baseSal;
      } else if (salType === "Per Bale" || salType === "Per KG") {
        const bales = await db
          .select()
          .from(factoryBales)
          .where(
            and(
              eq(factoryBales.companyId, companyId),
              eq(factoryBales.finalizedBy, id),
              gte(factoryBales.finalizedAt, new Date(effectiveStart)),
              lte(factoryBales.finalizedAt, new Date(endDate + "T23:59:59.999Z"))
            )
          );
        if (salType === "Per Bale") {
          earned = bales.length * parseFloat(worker.perBaleRate || "0");
        } else {
          const totalKg = bales.reduce((s: number, b) => s + parseFloat(b.weightKg || "0"), 0);
          earned = totalKg * parseFloat(worker.perKgRate || "0");
        }
      } else {
        // Monthly: base pay on actual attendance records in the effective period
        const attendanceRows = await db
          .select()
          .from(factoryAttendance)
          .where(
            and(
              eq(factoryAttendance.workerId, id),
              eq(factoryAttendance.companyId, companyId),
              gte(factoryAttendance.attendanceDate, effectiveStart),
              lte(factoryAttendance.attendanceDate, endDate)
            )
          );
        if (attendanceRows.length === 0) {
          // No attendance records — fall back to calendar-day proration
          earned = computeMonthlyPay(baseSal, effectiveStart, endDate);
        } else {
          earned = computeMonthlyPayFromAttendance(baseSal, effectiveStart, attendanceRows);
        }
      }

      // Compute already paid: any APPROVED/PAID payroll whose period overlaps the settlement window.
      // Use overlap condition (periodStart <= endDate AND periodEnd >= effectiveStart) instead of
      // strict containment so that date mismatches between the settlement input and the payroll
      // period boundaries never silently drop prior payments.
      //
      // IMPORTANT: use gross paid (netSalary + advances_deducted) rather than netSalary alone.
      // netSalary already has advance-recovery deductions subtracted. If we only sum netSalary,
      // the recovered advance money vanishes from the calculation, making the balance look higher
      // than it actually is (phantom "still owed" amount equal to the advance that was recovered).
      // Adding back the advances column gives us the gross salary amount, which correctly matches
      // the gross "earned" figure from attendance/calendar — and outstanding advance debt is
      // tracked separately in the advances field of the response.
      const paidPayrolls = await db
        .select()
        .from(factoryPayrolls)
        .where(
          and(
            eq(factoryPayrolls.workerId, id),
            eq(factoryPayrolls.companyId, companyId),
            lte(factoryPayrolls.periodStart, endDate),
            gte(factoryPayrolls.periodEnd, effectiveStart),
            inArray(factoryPayrolls.status, ["APPROVED", "PAID"])
          )
        );
      const totalPaid = paidPayrolls.reduce(
        (s: number, p) =>
          s + parseFloat(p.netSalary || "0") + parseFloat(p.advances || "0") + parseFloat(p.deductions || "0"),
        0
      );

      // Compute outstanding advances (remaining balance not yet recovered)
      const outstandingAdvances = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(
          and(
            eq(factoryWorkerAdvances.workerId, id),
            eq(factoryWorkerAdvances.companyId, companyId),
            eq(factoryWorkerAdvances.fullyPaid, false)
          )
        );
      const totalAdvances = outstandingAdvances.reduce((s: number, a) => s + parseFloat(a.remainingBalance || "0"), 0);

      const balance = earned - totalPaid - totalAdvances;

      // dryRun: just return calculation, no DB changes
      if (dryRun) {
        return res.json({
          earned: earned.toFixed(2),
          paid: totalPaid.toFixed(2),
          advances: totalAdvances.toFixed(2),
          balance: balance.toFixed(2),
          effectiveStart,
          dryRun: true,
        });
      }

      const settlementStatus = payNow ? "PAID" : "APPROVED";
      const settlementPaidAt = payNow ? new Date() : null;

      // Insert settlement payroll record
      const [settlement] = await db
        .insert(factoryPayrolls)
        .values({
          companyId,
          workerId: id,
          periodStart: effectiveStart,
          periodEnd: endDate,
          baseSalary: String(earned.toFixed(2)),
          baleEarnings: "0",
          kgEarnings: "0",
          overtimePay: "0",
          bonuses: "0",
          deductions: String(totalPaid.toFixed(2)),
          advances: String(totalAdvances.toFixed(2)),
          netSalary: String(balance.toFixed(2)),
          balesCount: 0,
          kgProcessed: "0",
          overtimeHours: "0",
          status: settlementStatus,
          notes: "Settlement - contract ended",
          cashAccountId: cashAccountId ? parseInt(cashAccountId) : null,
          paidAt: settlementPaidAt,
        })
        .returning();

      // Mark all outstanding advances as fully paid (recovered on settlement)
      if (outstandingAdvances.length > 0) {
        for (const adv of outstandingAdvances) {
          await db
            .update(factoryWorkerAdvances)
            .set({ fullyPaid: true, remainingBalance: "0" })
            .where(eq(factoryWorkerAdvances.id, adv.id));
        }
      }

      // Deactivate worker
      const today = getClientDate(req);
      await db
        .update(factoryWorkers)
        .set({ active: false, contractEndDate: endDate, updatedAt: new Date() })
        .where(eq(factoryWorkers.id, id));

      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "CONTRACT_SETTLED",
        referenceId: id,
        referenceTable: "factory_workers",
        description: `Settlement for ${worker.fullName}: earned $${earned.toFixed(2)}, paid $${totalPaid.toFixed(2)}, advances $${totalAdvances.toFixed(2)}, balance $${balance.toFixed(2)}`,
        amountCurrency: Math.abs(balance),
        amountUsd: Math.abs(balance),
        createdBy: req.session.userId ?? undefined,
      });

      res.json({
        earned: earned.toFixed(2),
        paid: totalPaid.toFixed(2),
        advances: totalAdvances.toFixed(2),
        balance: balance.toFixed(2),
        effectiveStart,
        settlementPayrollId: settlement.id,
        workerUpdated: true,
      });
    } catch (error: unknown) {
      logger.error("Error settling worker contract:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // (payroll routes already registered above, before /:id)
}
