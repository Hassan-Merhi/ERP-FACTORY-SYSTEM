import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  getCompanyId,
  ensureMonthlyLedgerRows,
  ensureMonthlyForCompany,
  postRentAccrualForCompany,
  type RentalModule,
} from "./shared";
import {
  postDueScheduledRentalPayments,
  createRentalPaymentGroup,
} from "../../services/rental/rentalPaymentPostingService";
import { db, pool } from "../../db";
import { getRentalBillingDay, getRentalPeriodDueDate } from "../../services/rental/rentalPeriodService";
import { requireAuth } from "../../auth";
import { z } from "zod";
import { eq, and, sql, desc, isNull } from "drizzle-orm";
import {
  propertyUnits,
  propertyContracts,
  propertyMonthlyLedger,
  propertyPayments,
  ledgerAccounts,
  vouchers,
  voucherEntries,
  interCompanyTransfers,
} from "@shared/schema";
import { parseId } from "../../lib/parseId";
import { getClientDate } from "../../lib/dateUtils";

export function registerRentalPaymentsAccrualRoutes(
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  incomeAccountName: string,
  shopExpenseAccountName: string = "Rent Expense - Shops"
) {
  const tag = `[${module}/rental]`;

  app.post(`${urlPrefix}/payments`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const data = z
        .object({
          contractId: z.number(),
          cashAccountId: z.number().nullable().optional(),
          amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
          paymentDate: z.string().min(1),
          notes: z.string().optional(),
          currency: z.string().optional().default("USD"),
          exchangeRate: z
            .union([z.string(), z.number()])
            .transform((v) => String(v))
            .optional()
            .default("1"),
          scheduleFuturePayment: z.boolean().optional().default(false),
        })
        .parse(req.body);

      let isSharedPayment = false;
      let [contract] = await db
        .select()
        .from(propertyContracts)
        .where(
          and(
            eq(propertyContracts.id, data.contractId),
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, module)
          )
        );
      // If not found as owner, check if it's a shared contract linked to this company
      if (!contract) {
        const [sharedContract] = await db
          .select()
          .from(propertyContracts)
          .where(
            and(
              eq(propertyContracts.id, data.contractId),
              eq(propertyContracts.linkedCompanyId, companyId),
              eq(propertyContracts.status, "ACTIVE")
            )
          );
        if (sharedContract) {
          contract = sharedContract;
          isSharedPayment = true;
        }
      }
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      const contractCompanyId = isSharedPayment ? contract.companyId : companyId;

      const [unit] = await db.select().from(propertyUnits).where(eq(propertyUnits.id, contract.unitId));
      const clientDate = getClientDate(req);

      const result = await createRentalPaymentGroup({
        companyId,
        contractCompanyId,
        module,
        contract,
        unit: unit ?? null,
        cashAccountId: data.cashAccountId ?? null,
        amount: data.amount,
        paymentDate: data.paymentDate,
        clientDate,
        scheduleFuturePayment: data.scheduleFuturePayment,
        currency: data.currency,
        exchangeRate: data.exchangeRate,
        notes: data.notes ?? null,
        shopExpenseAccountName,
        incomeAccountName,
        isSharedPayment,
      });

      if (result.scheduled) {
        return res.json({
          scheduled: true,
          paymentDate: data.paymentDate,
          paymentGroupId: result.paymentGroupId,
          allocations: result.payments.map((r) => ({
            year: r.forYear,
            month: r.forMonth,
            amount: r.amount,
          })),
          message: `Payment of ${data.amount} scheduled for ${data.paymentDate} (today is ${clientDate}). It will be posted automatically on that date.`,
        });
      }
      return res.json(result.payments[0] ?? { ok: true, paymentGroupId: result.paymentGroupId });
    } catch (e: unknown) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      if ((e as { status?: number }).status === 400) return res.status(400).json({ message: getErrorMessage(e) });
      logger.error(`${tag} payments:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── BULK PAYMENTS ──
  app.post(`${urlPrefix}/payments/bulk`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const items = z
        .array(
          z.object({
            contractId: z.number(),
            cashAccountId: z.number().nullable().optional(),
            amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
            paymentDate: z.string().min(1),
            notes: z.string().optional(),
            currency: z.string().optional().default("USD"),
            exchangeRate: z
              .union([z.string(), z.number()])
              .transform((v) => String(v))
              .optional()
              .default("1"),
            scheduleFuturePayment: z.boolean().optional().default(false),
          })
        )
        .min(1)
        .parse(req.body);

      const clientDate = getClientDate(req);
      type RentalBulkPaymentResult =
        | { contractId: number; error: string }
        | { contractId: number; scheduled: boolean; paymentGroupId: string; paymentsCreated: number };
      const results: RentalBulkPaymentResult[] = [];
      for (const data of items) {
        try {
          const [contract] = await db
            .select()
            .from(propertyContracts)
            .where(
              and(
                eq(propertyContracts.id, data.contractId),
                eq(propertyContracts.companyId, companyId),
                eq(propertyContracts.module, module)
              )
            );
          if (!contract) {
            results.push({ contractId: data.contractId, error: "Contract not found" });
            continue;
          }

          const [unit] = await db.select().from(propertyUnits).where(eq(propertyUnits.id, contract.unitId));

          const result = await createRentalPaymentGroup({
            companyId,
            contractCompanyId: companyId,
            module,
            contract,
            unit: unit ?? null,
            cashAccountId: data.cashAccountId ?? null,
            amount: data.amount,
            paymentDate: data.paymentDate,
            clientDate,
            scheduleFuturePayment: data.scheduleFuturePayment,
            currency: data.currency,
            exchangeRate: data.exchangeRate,
            notes: data.notes ?? null,
            shopExpenseAccountName,
            incomeAccountName,
            isSharedPayment: false,
          });

          results.push({
            contractId: data.contractId,
            scheduled: result.scheduled,
            paymentGroupId: result.paymentGroupId,
            paymentsCreated: result.payments.length,
          });
        } catch (itemErr: unknown) {
          results.push({ contractId: data.contractId, error: getErrorMessage(itemErr) });
        }
      }

      res.json({ processed: results.length, results });
    } catch (e: unknown) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      logger.error(`${tag} bulk-payments:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── DELETE PAYMENT (full reversal) ──
  app.delete(`${urlPrefix}/payments/:id`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const paymentId = parseId(req.params.id);
      if (paymentId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(paymentId)) return res.status(400).json({ message: "Invalid payment id" });

      const [payment] = await db
        .select()
        .from(propertyPayments)
        .where(
          and(
            eq(propertyPayments.id, paymentId),
            eq(propertyPayments.companyId, companyId),
            eq(propertyPayments.module, module)
          )
        );
      if (!payment) return res.status(404).json({ message: "Payment not found" });

      await db.transaction(async (tx) => {
        // 1. Reverse the monthly ledger paid_amount
        if (payment.ledgerRowId) {
          await tx.execute(sql`
            UPDATE property_monthly_ledger
            SET paid_amount = GREATEST(0, paid_amount - ${payment.amount}::numeric)
            WHERE id = ${payment.ledgerRowId}
          `);
        }

        // 2. Soft-delete the linked payment voucher ONLY if no other payment row
        //    references the same voucherId (split payments share one voucher)
        if (payment.voucherId) {
          const siblings = await tx
            .select({ id: propertyPayments.id })
            .from(propertyPayments)
            .where(and(eq(propertyPayments.voucherId, payment.voucherId), sql`${propertyPayments.id} != ${paymentId}`));
          if (siblings.length === 0) {
            await tx.execute(sql`
              UPDATE vouchers SET deleted_at = NOW() WHERE id = ${payment.voucherId}
            `);
            // Also soft-delete the AP-CLEAR auto-clearing journal created alongside this payment
            await tx.execute(sql`
              UPDATE vouchers SET deleted_at = NOW()
              WHERE voucher_number = ${"AP-CLEAR-" + payment.voucherId}
                AND company_id = ${companyId}
                AND deleted_at IS NULL
            `);
          }
        }

        // 3. Reverse any auto-transfers that were created for this payment
        //    Hard-delete both sides (entries + voucher) so the destination company's
        //    books are fully clean — matching the simple-company-transfer pattern.
        const linkedTransfers = await tx
          .select()
          .from(interCompanyTransfers)
          .where(eq(interCompanyTransfers.sourcePaymentId, paymentId));

        for (const transfer of linkedTransfers) {
          const fvid = transfer.fromVoucherId;
          const tvid = transfer.toVoucherId;
          // Delete the transfer record FIRST to release FK "restrict" constraints
          // on fromVoucherId / toVoucherId before hard-deleting those voucher rows.
          await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, transfer.id));
          if (fvid) {
            await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, fvid));
            await tx.delete(vouchers).where(eq(vouchers.id, fvid));
          }
          if (tvid) {
            await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, tvid));
            await tx.delete(vouchers).where(eq(vouchers.id, tvid));
          }
        }

        // 4. Delete the payment row itself
        await tx.delete(propertyPayments).where(eq(propertyPayments.id, paymentId));

        // 5. If this was a guarantee-release payment, reset guaranteePostedToStatement on the contract
        if (payment.notes && payment.notes.includes("[Guarantee release]") && payment.contractId) {
          await tx
            .update(propertyContracts)
            .set({ guaranteePostedToStatement: false })
            .where(eq(propertyContracts.id, payment.contractId));
        }
      });

      res.json({ ok: true });
    } catch (e: unknown) {
      logger.error(`${tag} delete-payment:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── UNIT DETAIL (ledger view) ──
  // FIX #6: uses asOfDate for all calculations; returns backend-calculated
  //          per-row fields and separate postedPayments/scheduledPayments.
  app.get(`${urlPrefix}/units/:id/detail`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const unitId = parseId(req.params.id);
      if (unitId === null) return res.status(400).json({ message: "Invalid id" });

      const asOfDate = getClientDate(req);

      let isShared = false;
      let [unit] = await db
        .select()
        .from(propertyUnits)
        .where(
          and(eq(propertyUnits.id, unitId), eq(propertyUnits.companyId, companyId), eq(propertyUnits.module, module))
        );

      if (!unit) {
        try {
          const [sharedContract] = await db
            .select()
            .from(propertyContracts)
            .where(
              and(
                eq(propertyContracts.unitId, unitId),
                eq(propertyContracts.linkedCompanyId, companyId),
                eq(propertyContracts.status, "ACTIVE")
              )
            );
          if (sharedContract) {
            const [ownerUnit] = await db.select().from(propertyUnits).where(eq(propertyUnits.id, unitId));
            if (ownerUnit) {
              unit = ownerUnit;
              isShared = true;
            }
          }
        } catch (sharedErr: unknown) {
          logger.warn(`${tag} shared-detail skipped:`, { error: getErrorMessage(sharedErr).split("\n")[0] });
        }
      }
      if (!unit) return res.status(404).json({ message: "Unit not found" });

      const [contract] = await db
        .select()
        .from(propertyContracts)
        .where(
          and(
            isShared ? eq(propertyContracts.linkedCompanyId, companyId) : eq(propertyContracts.companyId, companyId),
            ...(isShared ? [] : [eq(propertyContracts.module, module)]),
            eq(propertyContracts.unitId, unitId),
            eq(propertyContracts.status, "ACTIVE")
          )
        );

      type PropertyPaymentRow = typeof propertyPayments.$inferSelect;
      type RentalLedgerRow = typeof propertyMonthlyLedger.$inferSelect & {
        dueDate: string;
        isDue: boolean;
        expectedAsOf: number;
        effectivePaidAmount: number;
        allPostedPaid: number;
        scheduledAmount: number;
        outstanding: number;
        prepaidCredit: number;
        status: string;
      };
      let ledger: RentalLedgerRow[] = [];
      let postedPayments: PropertyPaymentRow[] = [];
      let scheduledPayments: PropertyPaymentRow[] = [];
      let guaranteePayments: PropertyPaymentRow[] = [];

      if (contract) {
        await ensureMonthlyLedgerRows(contract.id, asOfDate);

        const billingDay = getRentalBillingDay(contract.startDate as string);

        const rawLedger = await db
          .select()
          .from(propertyMonthlyLedger)
          .where(eq(propertyMonthlyLedger.contractId, contract.id))
          .orderBy(propertyMonthlyLedger.year, propertyMonthlyLedger.month);

        const allPayments = await db
          .select()
          .from(propertyPayments)
          .where(eq(propertyPayments.contractId, contract.id))
          .orderBy(desc(propertyPayments.paymentDate));

        guaranteePayments = allPayments.filter(
          (p) => p.ledgerRowId === null || (p.notes ?? "").includes("[Guarantee release]")
        );
        const rentPaymentsAll = allPayments.filter(
          (p) => p.ledgerRowId !== null && !(p.notes ?? "").includes("[Guarantee release]")
        );

        // Separate posted (effective) and scheduled
        postedPayments = rentPaymentsAll.filter(
          (p) => p.postingStatus === "POSTED" && String(p.paymentDate) <= asOfDate
        );
        scheduledPayments = rentPaymentsAll.filter((p) => p.postingStatus === "SCHEDULED");

        // Per-row effective paid totals (POSTED + payment_date <= asOfDate) — used for balance widget
        const { rows: paymentSums } = await pool.query<{ ledger_row_id: string; total_paid: string }>(
          `SELECT ledger_row_id, COALESCE(SUM(amount::numeric), 0) AS total_paid
           FROM property_payments
           WHERE contract_id = $1 AND posting_status = 'POSTED' AND payment_date <= $2
           GROUP BY ledger_row_id`,
          [contract.id, asOfDate]
        );
        const paidByRowId = new Map(paymentSums.map((r) => [parseInt(r.ledger_row_id), parseFloat(r.total_paid)]));

        // Per-row ALL posted paid totals (no date filter) — used for the statement PAID column.
        // Needed because payments can be POSTED with a future payment_date (e.g. tenant pays on
        // Jul 17 for a Jul 20 due date). Those payments are fully posted and should show in the
        // statement even though payment_date > asOfDate.
        const { rows: allPostedSums } = await pool.query<{ ledger_row_id: string; total_paid: string }>(
          `SELECT ledger_row_id, COALESCE(SUM(amount::numeric), 0) AS total_paid
           FROM property_payments
           WHERE contract_id = $1 AND posting_status = 'POSTED'
           GROUP BY ledger_row_id`,
          [contract.id]
        );
        const allPostedByRowId = new Map(
          allPostedSums.map((r) => [parseInt(r.ledger_row_id), parseFloat(r.total_paid)])
        );

        // Per-row scheduled totals
        const { rows: scheduledSums } = await pool.query<{ ledger_row_id: string; total_scheduled: string }>(
          `SELECT ledger_row_id, COALESCE(SUM(amount::numeric), 0) AS total_scheduled
           FROM property_payments
           WHERE contract_id = $1 AND posting_status = 'SCHEDULED'
           GROUP BY ledger_row_id`,
          [contract.id]
        );
        const scheduledByRowId = new Map(
          scheduledSums.map((r) => [parseInt(r.ledger_row_id), parseFloat(r.total_scheduled)])
        );

        // Enrich each ledger row with backend-calculated fields
        ledger = rawLedger.map((r) => {
          const dueDate = getRentalPeriodDueDate(r.year, r.month, billingDay);
          const isDue = dueDate <= asOfDate;
          const effectivePaidAmount = paidByRowId.get(r.id) ?? 0;
          // allPostedPaid: all POSTED payments for this ledger row, regardless of payment_date.
          // This is what the statement PAID column should display so that future-dated posted
          // payments (e.g. paid a few days early) are shown correctly.
          const allPostedPaid = allPostedByRowId.get(r.id) ?? 0;
          const scheduledAmt = scheduledByRowId.get(r.id) ?? 0;
          const expectedAmount = parseFloat(r.expectedAmount as string) || 0;
          const expectedAsOf = isDue ? expectedAmount : 0;
          const outstanding = Math.max(0, expectedAsOf - effectivePaidAmount);
          const prepaidCredit = Math.max(0, effectivePaidAmount - expectedAsOf);

          // Use allPostedPaid (not effectivePaidAmount) for status so that a POSTED future-dated
          // payment is correctly labelled PAID/PREPAID rather than NOT_DUE.
          let status: string;
          if (scheduledAmt > 0.005 && allPostedPaid < 0.005) {
            status = "SCHEDULED";
          } else if (!isDue && allPostedPaid < 0.005 && scheduledAmt < 0.005) {
            status = "NOT_DUE";
          } else if (!isDue && allPostedPaid > 0.005) {
            status = "PREPAID";
          } else if (isDue && allPostedPaid < 0.005) {
            status = "DUE";
          } else if (isDue && allPostedPaid > 0.005 && outstanding > 0.005 && allPostedPaid < expectedAmount - 0.005) {
            status = "PARTIALLY_PAID";
          } else if (isDue && allPostedPaid > expectedAmount + 0.005) {
            status = "OVERPAID";
          } else {
            status = "PAID";
          }

          return {
            ...r,
            dueDate,
            isDue,
            expectedAsOf,
            effectivePaidAmount,
            allPostedPaid,
            scheduledAmount: scheduledAmt,
            outstanding,
            prepaidCredit,
            status,
          };
        });
      }

      const pastContracts = await db
        .select()
        .from(propertyContracts)
        .where(
          and(
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, module),
            eq(propertyContracts.unitId, unitId),
            eq(propertyContracts.status, "ENDED")
          )
        )
        .orderBy(desc(propertyContracts.endDate));

      res.json({
        unit,
        contract: contract ?? null,
        ledger,
        postedPayments,
        scheduledPayments,
        guaranteePayments,
        pastContracts,
        isShared,
      });
    } catch (e: unknown) {
      logger.error(`${tag} detail:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── CASH ACCOUNTS picker ──
  app.get(`${urlPrefix}/cash-accounts`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accts = await db
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            eq(ledgerAccounts.active, true),
            isNull(ledgerAccounts.deletedAt)
          )
        );
      res.json(accts.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── GLOBAL PAYMENTS LOG ──
  app.get(`${urlPrefix}/payments`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const statusFilter = req.query.status as string | undefined;
      const conditions = [eq(propertyPayments.companyId, companyId), eq(propertyPayments.module, module)];
      if (statusFilter) {
        conditions.push(sql`${propertyPayments.postingStatus} = ${statusFilter}`);
      }

      const payments = await db
        .select({
          id: propertyPayments.id,
          paymentDate: propertyPayments.paymentDate,
          amount: propertyPayments.amount,
          forYear: propertyPayments.forYear,
          forMonth: propertyPayments.forMonth,
          notes: propertyPayments.notes,
          contractId: propertyPayments.contractId,
          unitId: propertyPayments.unitId,
          currency: propertyPayments.currency,
          exchangeRate: propertyPayments.exchangeRate,
          cashAccountId: propertyPayments.cashAccountId,
          voucherId: propertyPayments.voucherId,
          postingStatus: propertyPayments.postingStatus,
          paymentGroupId: propertyPayments.paymentGroupId,
          postedAt: propertyPayments.postedAt,
          tenantName: propertyContracts.tenantName,
          unitNumber: propertyUnits.unitNumber,
          locationGroup: propertyUnits.locationGroup,
        })
        .from(propertyPayments)
        .leftJoin(propertyContracts, eq(propertyContracts.id, propertyPayments.contractId))
        .leftJoin(propertyUnits, eq(propertyUnits.id, propertyPayments.unitId))
        .where(and(...conditions))
        .orderBy(desc(propertyPayments.paymentDate));

      res.json(payments);
    } catch (e: unknown) {
      logger.error(`${tag} payments-log:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── MANUAL MONTHLY ROLLOVER ──
  app.post(`${urlPrefix}/run-monthly`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      await ensureMonthlyForCompany(companyId, module);
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── ACCRUAL (ERP SHOP only) ────────────────────────────────────────────────
  // Manually post rent accrual journal vouchers for all unpaid ERP shop months.
  // Returns { accrued: N } where N = number of newly-posted accrual voucher rows.
  app.post(`${urlPrefix}/accrue`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const asOf = getClientDate(req);
      await ensureMonthlyForCompany(companyId, module, asOf);

      // Post all due, unaccrued rows as ONE combined journal voucher
      const { accrued, skipped } = await postRentAccrualForCompany(
        companyId,
        shopExpenseAccountName,
        module,
        incomeAccountName,
        asOf
      );

      res.json({ accrued, skipped });
    } catch (e: unknown) {
      logger.error(`${tag} accrue:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── SCHEDULED PAYMENTS — list ──────────────────────────────────────────────
  // Returns all SCHEDULED payment groups for this company/module.
  // Useful for the "pending payments" indicator in the UI.
  app.get(`${urlPrefix}/payments/scheduled`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rows = await db
        .select({
          id: propertyPayments.id,
          paymentGroupId: propertyPayments.paymentGroupId,
          contractId: propertyPayments.contractId,
          unitId: propertyPayments.unitId,
          amount: propertyPayments.amount,
          paymentDate: propertyPayments.paymentDate,
          forYear: propertyPayments.forYear,
          forMonth: propertyPayments.forMonth,
          currency: propertyPayments.currency,
          notes: propertyPayments.notes,
          postingStatus: propertyPayments.postingStatus,
          cashAccountId: propertyPayments.cashAccountId,
          createdAt: propertyPayments.createdAt,
        })
        .from(propertyPayments)
        .where(
          and(
            eq(propertyPayments.companyId, companyId),
            eq(propertyPayments.module, module),
            sql`${propertyPayments.postingStatus} = 'SCHEDULED'`
          )
        )
        .orderBy(propertyPayments.paymentDate, propertyPayments.contractId);

      // Group by paymentGroupId
      const groups = new Map<
        string,
        {
          paymentGroupId: string;
          contractId: number;
          unitId: number;
          paymentDate: string;
          currency: string;
          notes: string | null;
          cashAccountId: number | null;
          totalAmount: number;
          allocations: Array<{ id: number; year: number; month: number; amount: string }>;
        }
      >();

      for (const row of rows) {
        const gid = row.paymentGroupId ?? `no-group-${row.id}`;
        if (!groups.has(gid)) {
          groups.set(gid, {
            paymentGroupId: gid,
            contractId: row.contractId,
            unitId: row.unitId,
            paymentDate: String(row.paymentDate),
            currency: row.currency,
            notes: row.notes,
            cashAccountId: row.cashAccountId,
            totalAmount: 0,
            allocations: [],
          });
        }
        const g = groups.get(gid)!;
        g.totalAmount += parseFloat(row.amount as string);
        g.allocations.push({ id: row.id, year: row.forYear, month: row.forMonth, amount: row.amount as string });
      }

      res.json(Array.from(groups.values()).map((g) => ({ ...g, totalAmount: g.totalAmount.toFixed(2) })));
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── SCHEDULED PAYMENTS — manually trigger posting ─────────────────────────
  // Admin endpoint to manually post all due SCHEDULED payment groups.
  app.post(`${urlPrefix}/payments/post-scheduled`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const asOf = getClientDate(req);
      const posted = await postDueScheduledRentalPayments(companyId, module, asOf, shopExpenseAccountName);
      res.json({ posted, asOf });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── CANCEL SCHEDULED PAYMENT GROUP ────────────────────────────────────────
  app.delete(`${urlPrefix}/payments/scheduled/:groupId`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { groupId } = req.params;

      // Only cancel rows that are still SCHEDULED
      const deleted = await db
        .delete(propertyPayments)
        .where(
          and(
            eq(propertyPayments.companyId, companyId),
            eq(propertyPayments.module, module),
            sql`${propertyPayments.paymentGroupId} = ${groupId}`,
            sql`${propertyPayments.postingStatus} = 'SCHEDULED'`
          )
        )
        .returning({ id: propertyPayments.id });

      if (deleted.length === 0)
        return res.status(404).json({ message: "Scheduled payment group not found or already posted" });
      res.json({ cancelled: deleted.length, groupId });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── RESET + RE-ACCRUE (ERP SHOP only) ────────────────────────────────────
  // Deletes all existing individual accrual vouchers (where no payment has been
  // applied yet) and then immediately re-runs the combined accrual so the daybook
  // shows ONE journal instead of one-per-unit.
  //
  // Safe guard: rows where paidAmount > 0 are left alone — their accrual is already
  // partially settled and reversing it would leave the books inconsistent.
  //
  // Returns { reset: N, accrued: M } where:
  //   reset   = number of old individual vouchers deleted
  //   accrued = number of rows stamped with the new combined voucher
}
