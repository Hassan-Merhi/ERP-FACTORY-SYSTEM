import type { Express } from "express";
import { and, eq, sql } from "drizzle-orm";

import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { HttpError } from "../../lib/httpError";
import { validateRequest, validatedInput } from "../../lib/validateRequest";
import {
  createSalaryAdvanceInput,
  deleteSalaryAdvanceInput,
  reassignAdvanceWorkerInput,
  reconcileSalaryAdvancesInput,
  salaryAdvanceDeductionInput,
} from "./salaryAdvanceRoutesSchemas";
import { isPaidOff, reconcileSalaryAdvanceBalances } from "./salaryAdvanceReconcile";
import { storage } from "../../storage";
import {
  employees,
  insertSalaryAdvanceSchema,
  salaryAdvanceDeductions,
  salaryAdvances,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { toMoney } from "../../lib/money";
import { writeAuditEvent } from "../../services/audit";
import { applyEmployeeBalanceDeltasTx } from "../../services/accounting/employeeBalancePosting";
import {
  assertVoucherEditableTx,
  companyClosedThroughTx,
  recordVoucherEditAuditTx,
  sendVoucherCorrectionRefusal,
} from "../../services/accounting/voucherCorrection";
import { writeVoucherAuditTx } from "../helpers/voucherAuditTrail";
import {
  erpRequestSourceId,
  pairLines,
  postErpVoucherTx,
  sessionPostingActor,
} from "../../services/accounting/erpVoucherPosting";

export function registerSalaryAdvanceRoutes(app: Express): void {
  app.get("/api/salary-advances", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(await storage.getAllSalaryAdvances(companyId));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/salary-advances/employee/:employeeId", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const employeeId = parseInt(req.params.employeeId);
      if (isNaN(employeeId)) return res.status(400).json({ message: "Invalid employee ID" });
      // Only the active company's advances: any employee id used to return that
      // employee's advances whatever company they belonged to.
      res.json(await storage.getSalaryAdvancesByEmployee(employeeId, companyId));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Reassign an incorrectly attributed worker advance. An advance with any
  // repayments cannot be moved: the original worker's payroll history must
  // be corrected first. The voucher's employee subledger is moved atomically.
  app.patch(
    "/api/salary-advances/:id/worker",
    requireAuth,
    requireNonPOS,
    validateRequest(reassignAdvanceWorkerInput),
    async (req, res) => {
      try {
        if (!["Admin", "Owner", "Developer"].includes(req.session.currentRole ?? "")) {
          return res.status(403).json({ message: "Only Admin, Owner or Developer can reassign advances" });
        }
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { params, body } = validatedInput(req, reassignAdvanceWorkerInput);
        const advanceId = params.id;
        const newEmployeeId = body.employeeId;

        const updated = await db.transaction(async (tx) => {
          // Serializes concurrent worker corrections, and keeps the advance and
          // its linked employee ledger posting in the same database transaction.
          await tx.execute(sql`SELECT id FROM salary_advances
          WHERE id = ${advanceId} AND company_id = ${companyId} FOR UPDATE`);
          const [advance] = await tx
            .select()
            .from(salaryAdvances)
            .where(and(eq(salaryAdvances.id, advanceId), eq(salaryAdvances.companyId, companyId)));
          if (!advance) throw new HttpError(404, "Salary advance not found");
          const [newWorker] = await tx
            .select()
            .from(employees)
            .where(
              and(
                eq(employees.id, newEmployeeId),
                eq(employees.companyId, companyId),
                eq(employees.employeeType, "Worker")
              )
            );
          if (!newWorker) throw new HttpError(400, "Worker not found in the current company");
          if (advance.employeeId === newEmployeeId) return advance;

          const [deduction] = await tx
            .select({ id: salaryAdvanceDeductions.id })
            .from(salaryAdvanceDeductions)
            .where(eq(salaryAdvanceDeductions.salaryAdvanceId, advanceId))
            .limit(1);
          if (deduction || advance.fullyPaid || !toMoney(advance.amount).eq(toMoney(advance.remainingBalance))) {
            throw new HttpError(
              409,
              "This advance has already been repaid or deducted. Reverse the repayment or payroll deduction before changing its worker."
            );
          }

          const closedThrough = await companyClosedThroughTx(tx, companyId);
          if (closedThrough && advance.advanceDate <= closedThrough) {
            throw new HttpError(409, "This advance is in a closed accounting period and cannot be reassigned.");
          }

          const [previousWorker] = await tx
            .select()
            .from(employees)
            .where(and(eq(employees.id, advance.employeeId), eq(employees.companyId, companyId)));
          if (!previousWorker) throw new HttpError(409, "Original worker could not be found");

          if (advance.voucherId) {
            const { before, voucher } = await assertVoucherEditableTx(tx, advance.voucherId, { companyId });
            if (voucher.optional) {
              throw new HttpError(409, "The linked voucher is optional; review it before reassigning this advance.");
            }
            const employeeEntries = before.entries.filter((entry) => entry.employeeId !== null);
            const [debitEntry] = employeeEntries;
            if (
              employeeEntries.length !== 1 ||
              !debitEntry ||
              debitEntry.employeeId !== advance.employeeId ||
              !toMoney(debitEntry.debitAmount).eq(toMoney(advance.amount)) ||
              !toMoney(debitEntry.creditAmount).isZero()
            ) {
              throw new HttpError(
                409,
                "The linked voucher does not match this worker advance. Review the voucher before reassigning it."
              );
            }

            // Mirrors what the central voucher posting engine did for the
            // employee balance fields without altering amounts, cash or totals.
            await applyEmployeeBalanceDeltasTx({
              tx,
              companyId,
              entries: [debitEntry],
              direction: "reverse",
            });
            await tx
              .update(voucherEntries)
              .set({ employeeId: newEmployeeId })
              .where(and(eq(voucherEntries.id, debitEntry.id), eq(voucherEntries.voucherId, voucher.id)));
            await applyEmployeeBalanceDeltasTx({
              tx,
              companyId,
              entries: [{ ...debitEntry, employeeId: newEmployeeId }],
              direction: "apply",
            });

            const oldName = `${previousWorker.firstName} ${previousWorker.lastName ?? ""}`.trim();
            const newName = `${newWorker.firstName} ${newWorker.lastName ?? ""}`.trim();
            if (voucher.description === `Salary advance for ${oldName}`) {
              await tx
                .update(vouchers)
                .set({ description: `Salary advance for ${newName}` })
                .where(eq(vouchers.id, voucher.id));
            }
            await recordVoucherEditAuditTx(tx, {
              voucherId: voucher.id,
              before,
              actor: { userId: req.session.userId, username: req.session.username, companyId },
              reason: `Correct salary advance #${advanceId} worker assignment: ${oldName} -> ${newName}`,
              extra: {
                salaryAdvanceId: { new: advanceId },
                reassignedEmployeeId: { old: advance.employeeId, new: newEmployeeId },
              },
            });
          }

          const [result] = await tx
            .update(salaryAdvances)
            .set({ employeeId: newEmployeeId })
            .where(and(eq(salaryAdvances.id, advanceId), eq(salaryAdvances.companyId, companyId)))
            .returning();
          await writeAuditEvent(
            {
              userId: req.session.userId ?? "unknown",
              username: req.session.username || "unknown",
              companyId,
              action: "update",
              tableName: "salary_advances",
              recordId: advanceId,
              recordIdentifier: String(advanceId),
              changes: {
                employeeId: { old: advance.employeeId, new: newEmployeeId },
                salaryAdvance: { old: advance, new: result },
              },
              reason: "Correct worker assigned to salary advance",
            },
            tx
          );
          return result;
        });

        res.json(updated);
      } catch (error: unknown) {
        if (sendVoucherCorrectionRefusal(res, error)) return;
        res.status(error instanceof HttpError ? error.statusCode : 500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/salary-advances",
    requireAuth,
    requireNonPOS,
    validateRequest(createSalaryAdvanceInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const parsed = insertSalaryAdvanceSchema.parse({
          ...req.body,
          companyId,
          remainingBalance: req.body.amount,
          isOpeningBalance: req.body.isOpeningBalance || false,
        });
        const [employee] = await db.select().from(employees).where(eq(employees.id, parsed.employeeId)).limit(1);
        if (!employee) return res.status(404).json({ message: "Employee not found" });
        if (employee.companyId !== companyId) {
          return res.status(403).json({ message: "Employee belongs to a different company" });
        }

        let cashAccountId: number | null = null;
        if (!parsed.isOpeningBalance) {
          cashAccountId = req.body.cashAccountId || req.session.cashAccountId || null;
          if (!cashAccountId) return res.status(400).json({ message: "Cash account is required" });
        }

        // Wave 12: the voucher, its lines and the advance row are written in one
        // transaction and audited in it; any failure leaves nothing behind (they
        // used to autocommit one by one).
        const advance = await db.transaction(async (tx) => {
          let voucherId: number | null = null;
          let auditVoucher: {
            voucher: typeof vouchers.$inferSelect;
            entries: (typeof voucherEntries.$inferSelect)[];
          } | null = null;
          if (cashAccountId) {
            // Phase 22 (B): Dr employee / Cr cash through the central engine.
            const posted = await postErpVoucherTx(tx, {
              companyId,
              voucherType: "Payment",
              voucherDate: parsed.advanceDate,
              description: parsed.notes || `Salary advance for ${employee.firstName} ${employee.lastName}`,
              lines: pairLines(
                { employeeId: employee.id },
                { ledgerAccountId: cashAccountId },
                parsed.amount,
                "Salary advance"
              ),
              source: { type: "salary-advance", id: `${employee.id}:${erpRequestSourceId(req)}` },
              actor: sessionPostingActor(req, "Salary advance"),
            });
            const { voucher, entries } = posted;
            voucherId = voucher.id;
            if (posted.replayed) {
              // A resent request: the advance it created is returned, not added again.
              const [existing] = await tx
                .select()
                .from(salaryAdvances)
                .where(and(eq(salaryAdvances.companyId, companyId), eq(salaryAdvances.voucherId, voucher.id)));
              if (existing) return existing;
            }
            auditVoucher = { voucher, entries };
          }

          const [created] = await tx
            .insert(salaryAdvances)
            .values({ ...parsed, voucherId })
            .returning();

          const actor = { userId: req.session.userId, username: req.session.username, companyId };
          if (auditVoucher) {
            await writeVoucherAuditTx(tx, {
              actor,
              action: "create",
              voucherId: auditVoucher.voucher.id,
              before: null,
              after: auditVoucher,
              extra: { salaryAdvanceId: { new: created.id } },
            });
          }
          await writeAuditEvent(
            {
              userId: req.session.userId ?? "unknown",
              username: req.session.username || "unknown",
              companyId,
              action: "create",
              tableName: "salary_advances",
              recordId: created.id,
              recordIdentifier: auditVoucher?.voucher.voucherNumber ?? null,
              changes: { salaryAdvance: { new: created } },
            },
            tx
          );
          return created;
        });
        res.status(201).json(advance);
      } catch (error: unknown) {
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/salary-advances/:id/deduction",
    requireAuth,
    requireNonPOS,
    validateRequest(salaryAdvanceDeductionInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { params, body: parsed } = validatedInput(req, salaryAdvanceDeductionInput);
        const advanceId = params.id;
        const result = await db.transaction(async (tx) => {
          // Keep deduction and worker corrections serializable on the advance row.
          await tx.execute(sql`SELECT id FROM salary_advances
          WHERE id = ${advanceId} AND company_id = ${companyId} FOR UPDATE`);
          const [advance] = await tx
            .select()
            .from(salaryAdvances)
            .where(and(eq(salaryAdvances.id, advanceId), eq(salaryAdvances.companyId, companyId)));
          if (!advance) throw new HttpError(404, "Salary advance not found");
          if (advance.fullyPaid) throw new HttpError(400, "Salary advance is already fully paid");

          const deductionAmount = toMoney(parsed.deductionAmount);
          const remainingBalance = toMoney(advance.remainingBalance);
          if (deductionAmount.greaterThan(remainingBalance)) {
            throw new HttpError(400, `Deduction amount cannot exceed remaining balance of ${remainingBalance}`);
          }
          await tx.insert(salaryAdvanceDeductions).values({
            salaryAdvanceId: advanceId,
            payrollMonth: parsed.payrollMonth,
            deductionAmount: parsed.deductionAmount,
          });
          const newRemainingBalance = remainingBalance.minus(deductionAmount);
          const fullyPaid = isPaidOff(newRemainingBalance);
          await tx
            .update(salaryAdvances)
            .set({
              remainingBalance: newRemainingBalance.toFixed(2),
              fullyPaid,
            })
            .where(and(eq(salaryAdvances.id, advanceId), eq(salaryAdvances.companyId, companyId)));

          return {
            message: "Deduction recorded successfully",
            newRemainingBalance: newRemainingBalance.toFixed(2),
            fullyPaid,
          };
        });
        res.json(result);
      } catch (error: unknown) {
        res.status(error instanceof HttpError ? error.statusCode : 400).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.delete(
    "/api/salary-advances/:id",
    requireAuth,
    requireNonPOS,
    validateRequest(deleteSalaryAdvanceInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const advanceId = parseInt(req.params.id);
        if (isNaN(advanceId)) return res.status(400).json({ message: "Invalid salary advance ID" });
        const advance = await storage.getSalaryAdvanceById(advanceId);
        if (!advance) return res.status(404).json({ message: "Salary advance not found" });
        if (advance.companyId !== companyId) {
          return res.status(403).json({ message: "Salary advance belongs to a different company" });
        }
        await storage.deleteSalaryAdvance(advanceId);
        res.json({ message: "Salary advance deleted successfully" });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/salary-advances/reconcile",
    requireAuth,
    requireNonPOS,
    validateRequest(reconcileSalaryAdvancesInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const fixed = await reconcileSalaryAdvanceBalances(companyId);
        res.json({ message: `Reconciliation complete. ${fixed} advance(s) corrected.`, fixed });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get("/api/salary-advance-deductions", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db
        .select({
          id: salaryAdvanceDeductions.id,
          salaryAdvanceId: salaryAdvanceDeductions.salaryAdvanceId,
          payrollMonth: salaryAdvanceDeductions.payrollMonth,
          deductionAmount: salaryAdvanceDeductions.deductionAmount,
          createdAt: salaryAdvanceDeductions.createdAt,
          advanceDate: salaryAdvances.advanceDate,
          advanceAmount: salaryAdvances.amount,
          advanceRemaining: salaryAdvances.remainingBalance,
          employeeId: salaryAdvances.employeeId,
          employeeFirstName: employees.firstName,
          employeeLastName: employees.lastName,
        })
        .from(salaryAdvanceDeductions)
        .innerJoin(salaryAdvances, eq(salaryAdvanceDeductions.salaryAdvanceId, salaryAdvances.id))
        .innerJoin(employees, eq(salaryAdvances.employeeId, employees.id))
        .where(eq(salaryAdvances.companyId, companyId))
        .orderBy(sql`${salaryAdvanceDeductions.createdAt} DESC`);
      res.json(rows.map((row) => ({ ...row, workerName: `${row.employeeFirstName} ${row.employeeLastName}`.trim() })));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
