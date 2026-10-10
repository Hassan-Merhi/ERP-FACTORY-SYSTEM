import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import {
  factoryWorkers,
  factoryWorkerAdvances,
  factoryAdvanceRepayments,
  ledgerAccounts,
  vouchers,
  voucherEntries,
} from "@shared/schema";
import { getFactoryCompanyId, writeDaybookEntry } from "./helpers";
import { parseMoneyInput } from "../../../lib/money";

export function registerWorkerAdvancesRoutes(app: Express) {
  app.get("/api/factory/advance-repayments", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const conditions = [eq(factoryAdvanceRepayments.companyId, companyId)];
      const workerId = req.query.workerId ? parseOptionalId(req.query.workerId) : null;
      if (req.query.workerId && workerId === null) {
        return res.status(400).json({ message: "Invalid workerId" });
      }
      if (workerId !== null) conditions.push(eq(factoryAdvanceRepayments.workerId, workerId));

      const repayments = await db
        .select({
          id: factoryAdvanceRepayments.id,
          advanceId: factoryAdvanceRepayments.advanceId,
          workerId: factoryAdvanceRepayments.workerId,
          repaymentDate: factoryAdvanceRepayments.repaymentDate,
          amount: factoryAdvanceRepayments.amount,
          cashAccountId: factoryAdvanceRepayments.cashAccountId,
          notes: factoryAdvanceRepayments.notes,
          createdAt: factoryAdvanceRepayments.createdAt,
          advanceDate: factoryWorkerAdvances.advanceDate,
          advanceAmount: factoryWorkerAdvances.amount,
          advanceRemainingBalance: factoryWorkerAdvances.remainingBalance,
          workerName: factoryWorkers.fullName,
          cashAccountName: ledgerAccounts.name,
        })
        .from(factoryAdvanceRepayments)
        .innerJoin(factoryWorkerAdvances, eq(factoryAdvanceRepayments.advanceId, factoryWorkerAdvances.id))
        .innerJoin(factoryWorkers, eq(factoryAdvanceRepayments.workerId, factoryWorkers.id))
        .leftJoin(ledgerAccounts, eq(factoryAdvanceRepayments.cashAccountId, ledgerAccounts.id))
        .where(and(...conditions))
        .orderBy(desc(factoryAdvanceRepayments.repaymentDate));

      res.json(repayments);
    } catch (error: unknown) {
      logger.error("Error fetching advance repayments:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/advances - List all advances for company
  app.get("/api/factory/advances", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const conditions = [eq(factoryWorkerAdvances.companyId, companyId)];
      const workerId = req.query.workerId ? parseOptionalId(req.query.workerId) : null;
      if (req.query.workerId && workerId === null) {
        return res.status(400).json({ message: "Invalid workerId" });
      }
      if (workerId !== null) conditions.push(eq(factoryWorkerAdvances.workerId, workerId));
      if (req.query.status === "outstanding") conditions.push(eq(factoryWorkerAdvances.fullyPaid, false));
      if (req.query.status === "paid") conditions.push(eq(factoryWorkerAdvances.fullyPaid, true));

      const advances = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(and(...conditions))
        .orderBy(desc(factoryWorkerAdvances.advanceDate));

      const workerIds = [...new Set(advances.map((a) => a.workerId))];
      let workerMap: Record<number, string> = {};
      if (workerIds.length > 0) {
        const workers = await db
          .select({ id: factoryWorkers.id, fullName: factoryWorkers.fullName })
          .from(factoryWorkers)
          .where(inArray(factoryWorkers.id, workerIds));
        workerMap = Object.fromEntries(workers.map((w) => [w.id, w.fullName]));
      }

      const enriched = advances.map((a) => ({
        ...a,
        workerName: workerMap[a.workerId] || `Worker #${a.workerId}`,
      }));
      res.json(enriched);
    } catch (error: unknown) {
      logger.error("Error fetching advances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/workers/:id/advances - List advances for a specific worker
  app.get("/api/factory/workers/:id/advances", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const workerId = parseId(req.params.id);
      if (workerId === null) return res.status(400).json({ message: "Invalid id" });

      const advances = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(and(eq(factoryWorkerAdvances.companyId, companyId), eq(factoryWorkerAdvances.workerId, workerId)))
        .orderBy(desc(factoryWorkerAdvances.advanceDate));

      res.json(advances);
    } catch (error: unknown) {
      logger.error("Error fetching worker advances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/workers/:id/advances - Record a new advance
  app.post("/api/factory/workers/:id/advances", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const workerId = parseId(req.params.id);
      if (workerId === null) return res.status(400).json({ message: "Invalid id" });

      const amount = parseMoneyInput(req.body.amount)?.toDecimalPlaces(2) ?? null;
      if (!amount || amount.lte(0)) return res.status(400).json({ message: "Amount must be positive" });

      const [worker] = await db
        .select({ fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.id, workerId), eq(factoryWorkers.companyId, companyId)));
      if (!worker) return res.status(404).json({ message: "Worker not found" });

      const advanceDate = req.body.advanceDate || getClientDate(req);
      const cashAccountId = req.body.cashAccountId ? parseInt(req.body.cashAccountId) : null;

      if (cashAccountId) {
        const [acct] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, companyId)));
        if (!acct) return res.status(400).json({ message: "Cash account not found for this company" });
      }

      const repaymentType = req.body.repaymentType === "manual_repayment" ? "manual_repayment" : "salary_deduction";

      const result = await db.transaction(async (tx) => {
        const [advance] = await tx
          .insert(factoryWorkerAdvances)
          .values({
            companyId,
            workerId,
            advanceDate,
            amount: amount.toFixed(2),
            remainingBalance: amount.toFixed(2),
            cashAccountId,
            notes: req.body.notes || null,
            repaymentType,
          })
          .returning();

        let voucherId: number | null = null;

        if (cashAccountId) {
          let [advancesAccount] = await tx
            .select({ id: ledgerAccounts.id })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, "Factory Worker Advances")));

          if (!advancesAccount) {
            const maxCodeResult = await tx
              .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
              .from(ledgerAccounts)
              .where(and(eq(ledgerAccounts.companyId, companyId), sql`code ~ '^[0-9]+$'`));
            const nextCode = String((maxCodeResult[0]?.maxCode ?? 0) + 1);

            [advancesAccount] = await tx
              .insert(ledgerAccounts)
              .values({
                companyId,
                code: nextCode,
                name: "Factory Worker Advances",
                accountType: "Asset",
                active: true,
                isHidden: false,
              })
              .returning();
          }

          const voucherNumber = `PAYMENT-ADV-${advance.id}-${Date.now()}`;
          const narration = `Advance to ${worker.fullName}: $${amount.toFixed(2)}`;

          const [createdVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber,
              voucherType: "Payment",
              voucherDate: advanceDate,
              description: narration,
              totalAmount: amount.toFixed(2),
              currency: "USD",
              sourceModule: "FACTORY",
            })
            .returning();

          voucherId = createdVoucher.id;

          await tx.insert(voucherEntries).values([
            {
              voucherId: createdVoucher.id,
              ledgerAccountId: advancesAccount.id,
              debitAmount: amount.toFixed(2),
              creditAmount: "0",
              narration,
            },
            {
              voucherId: createdVoucher.id,
              ledgerAccountId: cashAccountId,
              debitAmount: "0",
              creditAmount: amount.toFixed(2),
              narration,
            },
          ]);
        }

        await writeDaybookEntry(tx, {
          companyId,
          txDate: advanceDate,
          txType: "ADVANCE_GIVEN",
          referenceId: advance.id,
          referenceTable: "factory_worker_advances",
          description: `Advance given to ${worker.fullName}: $${amount.toFixed(2)}`,
          amountCurrency: amount.toNumber(),
          amountUsd: amount.toNumber(),
          createdBy: req.session.userId ?? undefined,
        });

        return { ...advance, voucherId, workerName: worker.fullName };
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error creating advance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── Worker Deductions CRUD (ERP mirror — no factory guard) ─────────────────
  // These duplicate the /api/factory/worker-deductions endpoints but live outside
  // the factory middleware so ERP-mode users on the Payroll page can call them.
}
