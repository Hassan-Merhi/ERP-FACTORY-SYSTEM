import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  getCompanyId,
  monthlyLedgerRowsForRead,
  ensureMonthlyForCompany,
  postRentAccrualForCompany,
  type RentalModule,
} from "./shared";
import { createRentalPaymentGroup, isRentalRateRequiredError } from "../../services/rental/rentalPaymentPostingService";
import { postDueScheduledRentalPaymentsDetailed } from "../../services/rental/rentalDueScheduledPaymentService";
import { companyBusinessDate } from "../../services/accounting/companyBusinessDate";
import {
  companyClosedThrough,
  isDateInClosedPeriod,
  runInCompanyPostingScope,
} from "../../services/accounting/scheduledPostingScope";
import { db, pool } from "../../db";
import { getRentalBillingDay, getRentalPeriodDueDate } from "../../services/rental/rentalPeriodService";
import { requireAuth, requireRole } from "../../auth";
import { requireRentalDeletePermission } from "./rentalRoutePermissions";
import { z } from "zod";
import { eq, and, or, sql, desc, isNull } from "drizzle-orm";
import {
  propertyUnits,
  propertyContracts,
  propertyMonthlyLedger,
  propertyPayments,
  ledgerAccounts,
} from "@shared/schema";
import { parseId } from "../../lib/parseId";
import { getClientDate } from "../../lib/dateUtils";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../lib/money";
import {
  PROPERTIES_RENT_CASH_CODE,
  isPropertiesReceiptAccountType,
  propertiesRentCashboxSetupValues,
} from "../../services/rental/rentalCashboxPolicy";

export const RENTAL_POSTING_PERIOD_CLOSED_MESSAGE =
  "The books are closed through this date, so rent cannot be accrued on it.";

/** The signed-in user, as the actor of an audited rental posting (phase 19 B). */
function requestActor(req: Request): { userId: string; username: string } {
  return {
    userId: String(req.session.userId ?? ""),
    username: req.session.username || String(req.session.userId ?? "unknown"),
  };
}

/**
 * New Properties rent money belongs to a company-local cash ledger account.
 * Existing rental balances and past voucher entries are never migrated.
 */
async function validatePropertiesReceiptAccount(
  companyId: number,
  cashAccountId: number | null | undefined
): Promise<string | null> {
  if (!cashAccountId) return "Choose a Properties cashbox or cash/bank account before receiving rent.";
  const [account] = await db
    .select({
      id: ledgerAccounts.id,
      accountType: ledgerAccounts.accountType,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, cashAccountId),
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  if (!account || !isPropertiesReceiptAccountType(account.accountType)) {
    return "Choose an active cash/bank asset account belonging to the current Properties company.";
  }
  return null;
}

export function registerRentalPaymentsAccrualRoutes(
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  incomeAccountName: string,
  shopExpenseAccountName: string = "Rent Expense - Shops"
) {
  const tag = `[${module}/rental]`;

  // Explicit, zero-balance setup; never repost or reallocate historical rental receipts.
  // The endpoint is scoped to the selected Properties company and is idempotent by code.
  if (module === "PROPERTIES") {
    app.post(
      `${urlPrefix}/cashbox/ensure`,
      requireAuth,
      requireRole("Admin", "Owner", "Developer"),
      async (req: Request, res: Response) => {
        try {
          const companyId = getCompanyId(req);
          if (!companyId) return res.status(400).json({ message: "No company selected" });
          await db
            .insert(ledgerAccounts)
            .values(propertiesRentCashboxSetupValues(companyId))
            .onConflictDoNothing({ target: [ledgerAccounts.companyId, ledgerAccounts.code] });
          const [account] = await db
            .select()
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, PROPERTIES_RENT_CASH_CODE)))
            .limit(1);
          if (!account || account.deletedAt || !account.active || account.accountType !== "Cash") {
            return res.status(409).json({
              message:
                "The Properties cashbox code is already held by a deleted or incompatible account. Restore or correct it before continuing.",
            });
          }
          return res.json({ id: account.id, code: account.code, name: account.name, accountType: account.accountType });
        } catch (e: unknown) {
          logger.error("[PROPERTIES/rental] cashbox setup:", { error: e });
          return res
            .status(500)
            .json({ message: "Could not create the Properties cashbox without changing existing accounts." });
        }
      }
    );
  }

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
          // Phase 19 (B), PE2: not used for posting (the recorded dated rate is).
          exchangeRate: z
            .union([z.string(), z.number()])
            .transform((v) => String(v))
            .optional(),
          scheduleFuturePayment: z.boolean().optional().default(false),
          clientRequestId: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9._:-]+$/)
            .optional(),
        })
        .parse(req.body);

      if (module === "PROPERTIES") {
        const error = await validatePropertiesReceiptAccount(companyId, data.cashAccountId);
        if (error) return res.status(400).json({ message: error });
      }

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
      // A Properties reference must not create a second receipt or payment for Factory rent.
      if (module === "PROPERTIES" && isSharedPayment && contract.module === "FACTORY" && contract.isInternal) {
        return res.status(403).json({ message: "Record internal Factory lease payments in Factory Rentals." });
      }
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
        clientRequestId: data.clientRequestId,
        currency: data.currency,
        exchangeRate: data.exchangeRate ?? "",
        notes: data.notes ?? null,
        shopExpenseAccountName,
        incomeAccountName,
        isSharedPayment,
        audit: { actor: requestActor(req), trigger: "route" },
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
      // The rate refusal keeps its structured body (code, currency, date).
      if (isRentalRateRequiredError(e)) {
        return res.status(409).json({ message: e.message, code: e.code, currency: e.currency, date: e.date });
      }
      if ([400, 409].includes((e as { status?: number }).status ?? 0))
        return res.status((e as { status: number }).status).json({ message: getErrorMessage(e) });
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
              .optional(),
            scheduleFuturePayment: z.boolean().optional().default(false),
            clientRequestId: z
              .string()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9._:-]+$/)
              .optional(),
          })
        )
        .min(1)
        // New callers send { items } so the shared accounting middleware can
        // attach clientRequestId; retain array+header compatibility for old callers.
        .parse(Array.isArray(req.body) ? req.body : req.body?.items);

      const clientDate = getClientDate(req);
      // Validate the shared receipt account once before any bulk line is posted,
      // so an invalid account cannot silently create balance-only payment rows.
      if (module === "PROPERTIES") {
        for (const item of items) {
          const error = await validatePropertiesReceiptAccount(companyId, item.cashAccountId);
          if (error) return res.status(400).json({ message: error });
        }
      }
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
            clientRequestId: data.clientRequestId,
            currency: data.currency,
            exchangeRate: data.exchangeRate ?? "",
            notes: data.notes ?? null,
            shopExpenseAccountName,
            incomeAccountName,
            isSharedPayment: false,
            audit: { actor: requestActor(req), trigger: "route" },
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

  // Payment deletion is exclusively owned by the preceding atomic central route.

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

      // Same-company internal Factory shops appear in Properties without copying
      // units, contracts, ledgers or payment rows.
      if (!unit && module === "PROPERTIES") {
        const [factoryUnit] = await db
          .select()
          .from(propertyUnits)
          .where(
            and(
              eq(propertyUnits.id, unitId),
              eq(propertyUnits.companyId, companyId),
              eq(propertyUnits.module, "FACTORY"),
              eq(propertyUnits.unitType, "SHOP"),
              eq(propertyUnits.active, true)
            )
          );
        if (factoryUnit) {
          const [internalContract] = await db
            .select({ id: propertyContracts.id })
            .from(propertyContracts)
            .where(
              and(
                eq(propertyContracts.unitId, unitId),
                eq(propertyContracts.companyId, companyId),
                eq(propertyContracts.module, "FACTORY"),
                eq(propertyContracts.status, "ACTIVE"),
                eq(propertyContracts.isInternal, true)
              )
            );
          if (internalContract) {
            unit = factoryUnit;
            isShared = true;
          }
        }
      }

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
            isShared
              ? module === "PROPERTIES"
                ? or(
                    eq(propertyContracts.linkedCompanyId, companyId),
                    and(
                      eq(propertyContracts.companyId, companyId),
                      eq(propertyContracts.module, "FACTORY"),
                      eq(propertyContracts.isInternal, true)
                    )
                  )
                : eq(propertyContracts.linkedCompanyId, companyId)
              : eq(propertyContracts.companyId, companyId),
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
        // Phase 19 (B), PE2: a GET only reads; due months with no stored row
        // are computed in memory (it created and updated monthly rows).
        const billingDay = getRentalBillingDay(contract.startDate as string);

        const rawLedger = await monthlyLedgerRowsForRead(contract.id, asOfDate);

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
        const paidByRowId = new Map(paymentSums.map((r) => [parseInt(r.ledger_row_id), toMoney(r.total_paid)]));

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
        const allPostedByRowId = new Map(allPostedSums.map((r) => [parseInt(r.ledger_row_id), toMoney(r.total_paid)]));

        // Per-row scheduled totals
        const { rows: scheduledSums } = await pool.query<{ ledger_row_id: string; total_scheduled: string }>(
          `SELECT ledger_row_id, COALESCE(SUM(amount::numeric), 0) AS total_scheduled
           FROM property_payments
           WHERE contract_id = $1 AND posting_status = 'SCHEDULED'
           GROUP BY ledger_row_id`,
          [contract.id]
        );
        const scheduledByRowId = new Map(
          scheduledSums.map((r) => [parseInt(r.ledger_row_id), toMoney(r.total_scheduled)])
        );

        // Enrich each ledger row with backend-calculated fields
        ledger = rawLedger.map((r) => {
          const dueDate = getRentalPeriodDueDate(r.year, r.month, billingDay);
          const isDue = dueDate <= asOfDate;
          // Exact decimals: the balance figures are differences of cent amounts,
          // and float subtraction left residue such as 0.09999999999999432.
          const effectivePaid = paidByRowId.get(r.id) ?? new MoneyDecimal(0);
          // allPostedPaid: all POSTED payments for this ledger row, regardless of payment_date.
          // This is what the statement PAID column should display so that future-dated posted
          // payments (e.g. paid a few days early) are shown correctly.
          const allPosted = allPostedByRowId.get(r.id) ?? new MoneyDecimal(0);
          const scheduled = scheduledByRowId.get(r.id) ?? new MoneyDecimal(0);
          const expected = toMoney(r.expectedAmount as string);
          const expectedAsOfExact = isDue ? expected : new MoneyDecimal(0);
          const effectivePaidAmount = effectivePaid.toNumber();
          const allPostedPaid = allPosted.toNumber();
          const scheduledAmt = scheduled.toNumber();
          const expectedAmount = expected.toNumber();
          const expectedAsOf = expectedAsOfExact.toNumber();
          const outstanding = MoneyDecimal.max(0, expectedAsOfExact.minus(effectivePaid)).toNumber();
          const prepaidCredit = MoneyDecimal.max(0, effectivePaid.minus(expectedAsOfExact)).toNumber();

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
      const receiptAccounts =
        module === "PROPERTIES"
          ? accts.filter((a) => isPropertiesReceiptAccountType(a.accountType))
          : accts;
      res.json(receiptAccounts.sort((a, b) => a.name.localeCompare(b.name)));
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
      // This is exclusively a read-side reporting view. Payments are still posted,
      // owned, and deleted using their original module, company, and vouchers.
      // Warehouse Total Paid aggregates by ACTIVE contract rather than payment
      // module; the normal Properties log previously omitted ERP-module rent.
      const warehouseReconciliation = module === "PROPERTIES" && req.query.view === "warehouse-reconciliation";
      const conditions = warehouseReconciliation
        ? [
            eq(propertyPayments.companyId, companyId),
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, "PROPERTIES"),
            eq(propertyUnits.companyId, companyId),
            eq(propertyUnits.module, "PROPERTIES"),
            eq(propertyUnits.unitType, "WAREHOUSE"),
            eq(propertyUnits.active, true),
          ]
        : [eq(propertyPayments.companyId, companyId), eq(propertyPayments.module, module)];
      if (statusFilter) {
        conditions.push(sql`${propertyPayments.postingStatus} = ${statusFilter}`);
      }
      const asOf = getClientDate(req);

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
          sourceModule: propertyPayments.module,
          contractStatus: propertyContracts.status,
          ledgerRowId: propertyPayments.ledgerRowId,
          reconciliationCategory: sql<string>`CASE
            WHEN ${propertyPayments.postingStatus} = 'SCHEDULED'
              OR ${propertyPayments.paymentDate} > ${asOf} THEN 'SCHEDULED'
            WHEN ${propertyPayments.ledgerRowId} IS NULL THEN 'GUARANTEE'
            WHEN ${propertyContracts.status} = 'ENDED' THEN 'ENDED_RENT'
            WHEN ${propertyContracts.status} = 'ACTIVE'
              AND ${propertyPayments.postingStatus} = 'POSTED'
              AND ${propertyPayments.ledgerRowId} IS NOT NULL THEN 'ACTIVE_RENT'
            ELSE 'OTHER'
          END`,
          tenantName: propertyContracts.tenantName,
          unitNumber: propertyUnits.unitNumber,
          locationGroup: propertyUnits.locationGroup,
        })
        .from(propertyPayments)
        .leftJoin(propertyContracts, eq(propertyContracts.id, propertyPayments.contractId))
        .leftJoin(propertyUnits, eq(propertyUnits.id, propertyPayments.unitId))
        .where(and(...conditions))
        .orderBy(desc(propertyPayments.paymentDate));

      // Guarantee-to-statement creates a balanced Receipt voucher (Dr cash,
      // Cr Tenant Deposits) but intentionally does not insert a property_payments
      // record. Include those real receipts only in the warehouse reconciliation
      // read model, never by inserting/backfilling a payment or journal.
      //
      // Read-only negative IDs cannot collide with property_payments IDs.
      // Restrict to the GUAR-{sequence}-{contractId} family, its matching
      // Properties contract and warehouse, and both posted voucher legs.
      // Exclude voucher IDs already represented in property_payments.
      let combinedPayments: Array<Record<string, unknown>> = payments;
      if (warehouseReconciliation && (!statusFilter || statusFilter === "POSTED")) {
        const receiptResult = await db.execute(sql`
          WITH guarantee_vouchers AS MATERIALIZED (
            SELECT id, company_id, voucher_date, voucher_number, currency
            FROM vouchers
            WHERE company_id = ${companyId}
              AND deleted_at IS NULL
              AND optional = FALSE
              AND voucher_type = 'Receipt'
              AND voucher_number ~ ('^GUAR-[0-9]+-[0-9]+' || chr(36))
              AND description LIKE 'Guarantee deposit - %'
          )
          SELECT DISTINCT ON (v.id)
            -v.id::integer AS id,
            v.id::integer AS "voucherId",
            v.voucher_date::text AS "paymentDate",
            cash_line.debit_amount::text AS amount,
            EXTRACT(YEAR FROM v.voucher_date)::integer AS "forYear",
            EXTRACT(MONTH FROM v.voucher_date)::integer AS "forMonth",
            'Guarantee deposit (voucher-backed, read-only)'::text AS notes,
            contract.id::integer AS "contractId",
            unit.id::integer AS "unitId",
            COALESCE(v.currency, 'USD')::text AS currency,
            NULL::numeric AS "exchangeRate",
            cash_line.ledger_account_id::integer AS "cashAccountId",
            'POSTED'::text AS "postingStatus",
            NULL::text AS "paymentGroupId",
            NULL::timestamptz AS "postedAt",
            'PROPERTIES'::text AS "sourceModule",
            contract.status::text AS "contractStatus",
            NULL::integer AS "ledgerRowId",
            'GUARANTEE'::text AS "reconciliationCategory",
            'GUARANTEE_DEPOSIT'::text AS "receiptKind",
            TRUE AS "readOnly",
            contract.tenant_name::text AS "tenantName",
            unit.unit_number::text AS "unitNumber",
            unit.location_group::text AS "locationGroup"
          FROM guarantee_vouchers v
          JOIN property_contracts contract
            ON contract.id = split_part(v.voucher_number, '-', 3)::integer
           AND contract.company_id = v.company_id
           AND contract.module = 'PROPERTIES'
          JOIN property_units unit
            ON unit.id = contract.unit_id
           AND unit.company_id = v.company_id
           AND unit.module = 'PROPERTIES'
           AND unit.unit_type = 'WAREHOUSE'
           AND unit.active = TRUE
          JOIN voucher_entries cash_line
            ON cash_line.voucher_id = v.id
           AND cash_line.company_id = v.company_id
           AND cash_line.debit_amount > 0
          JOIN ledger_accounts cash_account
            ON cash_account.id = cash_line.ledger_account_id
           AND cash_account.company_id = v.company_id
           AND cash_account.account_type IN ('Cash', 'Bank', 'Asset')
          JOIN voucher_entries deposit_line
            ON deposit_line.voucher_id = v.id
           AND deposit_line.company_id = v.company_id
           AND deposit_line.credit_amount = cash_line.debit_amount
          JOIN ledger_accounts deposit_account
            ON deposit_account.id = deposit_line.ledger_account_id
           AND deposit_account.company_id = v.company_id
           AND deposit_account.account_type = 'Liability'
           AND deposit_account.name = 'Tenant Deposits'
          WHERE NOT EXISTS (
            SELECT 1 FROM property_payments previous
            WHERE previous.company_id = v.company_id
              AND previous.voucher_id = v.id
          )
          ORDER BY v.id, cash_line.ledger_account_id
        `);
        const receiptRows = receiptResult.rows as Array<Record<string, unknown>>;
        combinedPayments = [...payments, ...receiptRows].sort((left, right) =>
          String(right.paymentDate).localeCompare(String(left.paymentDate)) ||
          Number(right.id) - Number(left.id)
        );
      }
      res.json(combinedPayments);
    } catch (e: unknown) {
      logger.error(`${tag} payments-log:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── MANUAL MONTHLY ROLLOVER ──
  // Phase 19 (B), PE2: Admin/Owner, the company's business date, its tenant
  // scope (monthly rows only, no voucher).
  app.post(
    `${urlPrefix}/run-monthly`,
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const asOf = await runInCompanyPostingScope(companyId, async () => {
          const businessDate = await companyBusinessDate(companyId);
          await ensureMonthlyForCompany(companyId, module, businessDate);
          return businessDate;
        });
        res.json({ ok: true, asOf });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ── ACCRUAL (ERP SHOP only) ────────────────────────────────────────────────
  // Manually post rent accrual journal vouchers for all unpaid ERP shop months.
  // Returns { accrued: N } where N = number of newly-posted accrual voucher rows.
  // Phase 19 (B), PE2: Admin/Owner; dated by the company's business date (it
  // was the client's), in the company's tenant scope, refused (409) when that
  // date is in a closed period; each voucher audited with the signed-in user.
  app.post(`${urlPrefix}/accrue`, requireAuth, requireRole("Admin", "Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const outcome = await runInCompanyPostingScope(companyId, async () => {
        const asOf = await companyBusinessDate(companyId);
        const closedThrough = await companyClosedThrough(companyId);
        if (isDateInClosedPeriod(closedThrough, asOf)) return { closed: true as const, asOf, closedThrough };
        await ensureMonthlyForCompany(companyId, module, asOf);
        // Post all due, unaccrued rows as ONE combined journal voucher
        const result = await postRentAccrualForCompany(
          companyId,
          shopExpenseAccountName,
          module,
          incomeAccountName,
          asOf,
          { actor: requestActor(req), trigger: "route" }
        );
        return { closed: false as const, asOf, ...result };
      });
      if (outcome.closed) {
        return res.status(409).json({
          message: RENTAL_POSTING_PERIOD_CLOSED_MESSAGE,
          code: "PERIOD_CLOSED",
          asOf: outcome.asOf,
          closedThrough: outcome.closedThrough,
        });
      }
      const { accrued, skipped, asOf } = outcome;
      res.json({ accrued, skipped, asOf });
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
          totalAmount: Decimal;
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
            totalAmount: new MoneyDecimal(0),
            allocations: [],
          });
        }
        const g = groups.get(gid)!;
        g.totalAmount = g.totalAmount.plus(toMoney(row.amount as string));
        g.allocations.push({ id: row.id, year: row.forYear, month: row.forMonth, amount: row.amount as string });
      }

      res.json(Array.from(groups.values()).map((g) => ({ ...g, totalAmount: g.totalAmount.toFixed(2) })));
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── SCHEDULED PAYMENTS — manually trigger posting ─────────────────────────
  // Admin endpoint to manually post all due SCHEDULED payment groups.
  // Phase 19 (B), PE2: Admin/Owner; due as of the company's business date (it
  // was the client's), in the company's tenant scope, a group dated in a
  // closed period skipped and reported; audited with the signed-in user (it
  // was audited as the scheduler).
  app.post(
    `${urlPrefix}/payments/post-scheduled`,
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { asOf, result } = await runInCompanyPostingScope(companyId, async () => {
          const businessDate = await companyBusinessDate(companyId);
          const closedThrough = await companyClosedThrough(companyId);
          return {
            asOf: businessDate,
            result: await postDueScheduledRentalPaymentsDetailed(
              companyId,
              module,
              businessDate,
              shopExpenseAccountName,
              incomeAccountName,
              { closedThrough, actor: requestActor(req), trigger: "route" }
            ),
          };
        });
        res.json({ posted: result.posted, failed: result.failed, skipped: result.skipped, asOf });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ── CANCEL SCHEDULED PAYMENT GROUP ────────────────────────────────────────
  app.delete(`${urlPrefix}/payments/scheduled/:groupId`, requireAuth, requireRentalDeletePermission, async (req: Request, res: Response) => {
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
