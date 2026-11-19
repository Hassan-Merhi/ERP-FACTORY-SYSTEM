import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getCompanyId, ensureMonthlyForCompany, postRentAccrualForCompany, type RentalModule } from "./shared";
import { postDueScheduledRentalPaymentsDetailed } from "../../services/rental/rentalDueScheduledPaymentService";
import { companyBusinessDate } from "../../services/accounting/companyBusinessDate";
import {
  companyClosedThrough,
  isDateInClosedPeriod,
  runInCompanyPostingScope,
} from "../../services/accounting/scheduledPostingScope";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { requireRentalDeletePermission } from "./rentalRoutePermissions";
import { validateRequest, validatedInput } from "../../lib/validateRequest";
import { cancelScheduledPaymentGroupInput, rentalActionInput } from "./rentalWriteRouteSchemas";
import { eq, and, sql } from "drizzle-orm";
import { propertyPayments } from "@shared/schema";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { registerRentalPaymentsAccrualRoutesStep1, requestActor } from "./registerRentalPaymentsAccrualRoutesStep1";
import { registerRentalPaymentsAccrualRoutesStep2 } from "./registerRentalPaymentsAccrualRoutesStep2";
import { registerRentalPaymentsAccrualRoutesStep3 } from "./registerRentalPaymentsAccrualRoutesStep3";
import { registerRentalPaymentsAccrualRoutesStep4 } from "./registerRentalPaymentsAccrualRoutesStep4";

export const RENTAL_POSTING_PERIOD_CLOSED_MESSAGE =
  "The books are closed through this date, so rent cannot be accrued on it.";

export function registerRentalPaymentsAccrualRoutes(
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  incomeAccountName: string,
  shopExpenseAccountName: string = "Rent Expense - Shops"
) {
  const { tag } = registerRentalPaymentsAccrualRoutesStep1(
    app,
    module,
    urlPrefix,
    incomeAccountName,
    shopExpenseAccountName
  );
  registerRentalPaymentsAccrualRoutesStep2({ tag }, app, module, urlPrefix, incomeAccountName, shopExpenseAccountName);
  registerRentalPaymentsAccrualRoutesStep3({ tag }, app, module, urlPrefix);
  registerRentalPaymentsAccrualRoutesStep4({ tag }, app, module, urlPrefix);
  registerRentalPaymentsAccrualRoutesStep5({ tag }, app, module, urlPrefix, incomeAccountName, shopExpenseAccountName);

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

function registerRentalPaymentsAccrualRoutesStep5(
  { tag }: Pick<Awaited<ReturnType<typeof registerRentalPaymentsAccrualRoutesStep1>>, "tag">,
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  incomeAccountName: string,
  shopExpenseAccountName: string = "Rent Expense - Shops"
) {
  // ── ACCRUAL (ERP SHOP only) ────────────────────────────────────────────────
  // Manually post rent accrual journal vouchers for all unpaid ERP shop months.
  // Returns { accrued: N } where N = number of newly-posted accrual voucher rows.
  // Phase 19 (B), PE2: Admin/Owner; dated by the company's business date (it
  // was the client's), in the company's tenant scope, refused (409) when that
  // date is in a closed period; each voucher audited with the signed-in user.
  app.post(
    `${urlPrefix}/accrue`,
    requireAuth,
    requireRole("Admin", "Owner"),
    validateRequest(rentalActionInput),
    async (req: Request, res: Response) => {
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
    }
  );

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
    validateRequest(rentalActionInput),
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
  app.delete(
    `${urlPrefix}/payments/scheduled/:groupId`,
    requireAuth,
    requireRentalDeletePermission,
    validateRequest(cancelScheduledPaymentGroupInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { groupId } = validatedInput(req, cancelScheduledPaymentGroupInput).params;

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
    }
  );
  return {};
}
