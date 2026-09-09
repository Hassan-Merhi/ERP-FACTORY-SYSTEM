import type { Database, RawQueryRow } from "../../db";
import type { DbTransaction } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { checkFactoryAdmin } from "../factory/_helpers";
import { logAudit } from "../helpers/auditHelpers";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { parseId } from "../../lib/parseId";
import { rebuildPayrollGenVoucher } from "../payroll/_payrollAccountingHelper";

import {
  getProductionBonusDetailsForPayroll,
  getProductionBonusTotalsForPayrollIds,
  prepareProductionBonusesForPayroll,
  updateProductionBonusRunStatuses,
} from "../../services/payroll/productionBonusPayrollService";

/**
 * Raw projections behind the production-bonus decision flow. `bonuses` and
 * `net_salary` are cast to text in the query, so they arrive as strings.
 */
interface PayrollLockRow {
  id: number;
  companyId: number;
  workerId: number;
  periodStart: string;
  periodEnd: string;
  status: string;
}

interface PayrollFinancialRow {
  bonuses: string | null;
  netSalary: string | null;
}

interface BonusAllocationRow {
  runId: number;
  workerId: number;
}

interface DecisionItem {
  runId: number;
  workerId: number;
}

function parseDecisionItems(value: unknown): DecisionItem[] {
  if (!Array.isArray(value)) return [];
  const dedupe = new Map<string, DecisionItem>();
  for (const raw of value) {
    const runId = Number(raw?.runId);
    const workerId = Number(raw?.workerId);
    if (!Number.isInteger(runId) || runId <= 0 || !Number.isInteger(workerId) || workerId <= 0) continue;
    dedupe.set(`${runId}:${workerId}`, { runId, workerId });
  }
  return [...dedupe.values()];
}

const emptyTotals = () => ({
  approved: 0,
  pending: 0,
  rejected: 0,
  totalSuggested: 0,
  pendingCount: 0,
  approvedCount: 0,
  rejectedCount: 0,
});

export function registerFactoryProductionBonusRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  app.get("/api/factory/payroll/:id/production-bonuses", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid payroll id" });
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const payrollResult = await db.execute<RawQueryRow<{ id: number }>>(sql`
        SELECT id FROM factory_payrolls WHERE id = ${id} AND company_id = ${companyId} LIMIT 1
      `);
      if (!payrollResult.rows[0]) return res.status(404).json({ message: "Payroll record not found" });
      res.json(await getProductionBonusDetailsForPayroll(db, id));
    } catch (error: unknown) {
      logger.error("Error loading production bonuses for payroll", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/payroll/:id/production-bonuses/decision", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!checkFactoryAdmin(req, res)) return;
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid payroll id" });
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const decision = String(req.body?.decision ?? "").toUpperCase();
      if (!["APPROVED", "REJECTED"].includes(decision)) {
        return res.status(400).json({ message: "decision must be APPROVED or REJECTED" });
      }
      const items = parseDecisionItems(req.body?.items);
      const applyAll = req.body?.all === true;
      if (!applyAll && items.length === 0) {
        return res.status(400).json({ message: "Choose at least one production bonus allocation" });
      }
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) || null : null;
      const decidedBy = req.session?.userId ? String(req.session.userId) : null;

      const result = await db.transaction(async (tx: DbTransaction) => {
        const payrollResult = await tx.execute<RawQueryRow<PayrollLockRow>>(sql`
          SELECT id, company_id AS "companyId", worker_id AS "workerId",
                 period_start::text AS "periodStart", period_end::text AS "periodEnd", status
          FROM factory_payrolls
          WHERE id = ${id} AND company_id = ${companyId}
          FOR UPDATE
        `);
        const payroll = payrollResult.rows[0];
        if (!payroll) throw new Error("Payroll record not found");
        if (String(payroll.status) !== "DRAFT") {
          throw new Error("Production bonus decisions can only be changed while payroll is DRAFT");
        }

        // May reattach an already-approved orphan allocation from an earlier
        // deleted payroll. Re-read financial values after preparation so the
        // decision delta starts from the current authoritative total/net.
        await prepareProductionBonusesForPayroll(tx, id);
        const financialResult = await tx.execute<RawQueryRow<PayrollFinancialRow>>(sql`
          SELECT bonuses::text AS bonuses, net_salary::text AS "netSalary"
          FROM factory_payrolls WHERE id = ${id} AND company_id = ${companyId} LIMIT 1
        `);
        const financial = financialResult.rows[0];
        if (!financial) throw new Error("Payroll record not found");

        const oldTotals = (await getProductionBonusTotalsForPayrollIds(tx, [id])).get(id) ?? emptyTotals();
        const linkedResult = await tx.execute<RawQueryRow<BonusAllocationRow>>(sql`
          SELECT run_id AS "runId", worker_id AS "workerId"
          FROM factory_production_bonus_allocations
          WHERE payroll_id = ${id}
        `);
        const linked = linkedResult.rows.map((row) => ({
          runId: Number(row.runId),
          workerId: Number(row.workerId),
        }));
        const requested = applyAll
          ? linked
          : linked.filter((candidate) =>
              items.some((item) => item.runId === candidate.runId && item.workerId === candidate.workerId)
            );
        if (requested.length === 0)
          throw new Error("No matching production bonus allocations were found on this payroll");

        const affectedRunIds: number[] = [];
        for (const item of requested) {
          const updateResult = await tx.execute<RawQueryRow<{ run_id: number }>>(sql`
            UPDATE factory_production_bonus_allocations
            SET decision_status = ${decision}, decided_by = ${decidedBy}, decided_at = NOW(),
                decision_note = ${note}, updated_at = NOW()
            WHERE payroll_id = ${id} AND run_id = ${item.runId} AND worker_id = ${item.workerId}
            RETURNING run_id
          `);
          if (updateResult.rows[0]) affectedRunIds.push(item.runId);
        }
        await updateProductionBonusRunStatuses(tx, affectedRunIds);

        const newTotals = (await getProductionBonusTotalsForPayrollIds(tx, [id])).get(id) ?? emptyTotals();
        const totalBonusBefore = Number(financial.bonuses ?? 0);
        const otherBonus = Math.max(0, totalBonusBefore - oldTotals.approved);
        const totalBonusAfter = Number((otherBonus + newTotals.approved).toFixed(2));
        const netSalary = Number((Number(financial.netSalary ?? 0) + (totalBonusAfter - totalBonusBefore)).toFixed(2));

        await tx.execute(sql`
          UPDATE factory_payrolls
          SET bonuses = ${totalBonusAfter.toFixed(2)}, net_salary = ${netSalary.toFixed(2)}
          WHERE id = ${id} AND company_id = ${companyId}
        `);
        await rebuildPayrollGenVoucher(tx, Number(companyId), String(payroll.periodStart), String(payroll.periodEnd));

        return {
          details: await getProductionBonusDetailsForPayroll(tx, id),
          otherBonus,
          totalBonus: totalBonusAfter,
          netSalary,
          affected: requested.length,
        };
      });

      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || req.session.userId!,
          companyId: Number(companyId),
          action: "update",
          tableName: "factory_production_bonus_allocations",
          recordId: null,
          recordIdentifier: `Payroll #${id} production bonuses — ${decision}`,
          changes: {
            decision: { old: null, new: decision },
            affectedAllocations: { old: 0, new: result.affected },
            totalApprovedProductionBonus: { old: null, new: result.details.totals.approved },
          },
        });
      } catch (auditError) {
        logger.error("[production bonus decision audit] non-fatal", { error: auditError });
      }

      res.json(result);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      const status = /not found/i.test(message)
        ? 404
        : /only be changed while payroll is DRAFT/i.test(message)
          ? 409
          : 400;
      res.status(status).json({ message });
    }
  });
}
