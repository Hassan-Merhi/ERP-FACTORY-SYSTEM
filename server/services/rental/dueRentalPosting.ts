/**
 * Due rental postings of one company (accounting audit wave 18 A, owner
 * decision 3 of 2026-10-10): the scheduled payment groups that have reached
 * their date and the rent accruals/recognitions that are due.
 *
 * Before: `GET {rental}/units` posted them on every page load, dated by the
 * client's date, for any signed-in user; the daily scheduler posted the
 * accruals (not the scheduled payments) in the maintenance scope, which the
 * closed-period guard bypasses.
 *
 * Now one code path serves the daily scheduled job and the Admin/Owner
 * "post due accruals now" action:
 * - it runs in the company's tenant database scope (closed-period guard and
 *   opening lock apply);
 * - it is dated by the company's business date (companyBusinessDate);
 * - a scheduled payment dated in a closed period, and the accrual run when the
 *   business date itself is closed, are skipped and reported (PERIOD_CLOSED),
 *   never forced;
 * - every voucher it posts has an audit row in its posting transaction, with
 *   the actor and the trigger.
 */
import { logger } from "../../lib/logger";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import {
  companyClosedThrough,
  isDateInClosedPeriod,
  runInCompanyPostingScope,
  type ScheduledPostingSkip,
} from "../accounting/scheduledPostingScope";
import { ensureMonthlyForCompany, postRentAccrualForCompany, type RentalModule } from "../../routes/rental/shared";
import { postDueScheduledRentalPaymentsDetailed } from "./rentalPaymentPostingService";

/** The accounts each rental module posts to (as registered in the rental route modules). */
export const RENTAL_MODULE_ACCOUNTS: Record<RentalModule, { income: string; expense: string }> = {
  ERP: { income: "Rental Income - ERP", expense: "Rent Expense - ERP Shops" },
  FACTORY: { income: "Rental Income - Factory", expense: "Rent Expense - Factory Shops" },
  PROPERTIES: { income: "Rental Income - Properties", expense: "Rent Expense - Property Shops" },
};

export interface DueRentalPostingOptions {
  trigger: "scheduler" | "manual";
  actor?: { userId: string; username: string };
  incomeAccountName?: string;
  shopExpenseAccountName?: string;
}

export interface DueRentalPostingResult {
  companyId: number;
  module: RentalModule;
  asOfDate: string;
  closedThrough: string | null;
  scheduledPaymentsPosted: number;
  scheduledPaymentsFailed: number;
  accrued: number;
  alreadyAccrued: number;
  skipped: ScheduledPostingSkip[];
}

const SCHEDULER_ACTOR = { userId: "system", username: "rental-accrual-scheduler" } as const;

/** Posts the company's due scheduled payments and accruals for one module, in its tenant scope. */
export function postDueRentalForCompany(
  companyId: number,
  module: RentalModule,
  options: DueRentalPostingOptions
): Promise<DueRentalPostingResult> {
  return runInCompanyPostingScope(companyId, async () => {
    const accounts = RENTAL_MODULE_ACCOUNTS[module];
    const income = options.incomeAccountName ?? accounts.income;
    const expense = options.shopExpenseAccountName ?? accounts.expense;
    const actor = options.actor ?? SCHEDULER_ACTOR;
    const asOfDate = await companyBusinessDate(companyId);
    const closedThrough = await companyClosedThrough(companyId);
    const skipped: ScheduledPostingSkip[] = [];

    // Monthly rent rows (no voucher) up to the business date.
    await ensureMonthlyForCompany(companyId, module, asOfDate);

    let scheduledPaymentsPosted = 0;
    let scheduledPaymentsFailed = 0;
    // Scheduled payments post in the owned-shop modules, as the units page did.
    if (module === "ERP" || module === "FACTORY") {
      const payments = await postDueScheduledRentalPaymentsDetailed(companyId, module, asOfDate, expense, income, {
        closedThrough,
        actor,
        trigger: options.trigger,
      });
      scheduledPaymentsPosted = payments.posted;
      scheduledPaymentsFailed = payments.failed;
      for (const skip of payments.skipped) {
        skipped.push({
          companyId,
          reference: `rental-scheduled-payment:${skip.paymentGroupId}`,
          date: skip.paymentDate,
          reason: "PERIOD_CLOSED",
          closedThrough: skip.closedThrough,
        });
      }
    }

    let accrued = 0;
    let alreadyAccrued = 0;
    // The accrual vouchers are dated on the business date.
    if (isDateInClosedPeriod(closedThrough, asOfDate)) {
      skipped.push({
        companyId,
        reference: `rental-accrual:${module}`,
        date: asOfDate,
        reason: "PERIOD_CLOSED",
        closedThrough,
      });
    } else {
      const result = await postRentAccrualForCompany(companyId, expense, module, income, asOfDate, {
        actor,
        trigger: options.trigger,
      });
      accrued = result.accrued;
      alreadyAccrued = result.skipped;
    }

    if (skipped.length) {
      logger.warn("[RentalAccrual] postings skipped: date in a closed period", {
        companyId,
        module,
        asOfDate,
        closedThrough,
        skipped,
      });
    }
    return {
      companyId,
      module,
      asOfDate,
      closedThrough,
      scheduledPaymentsPosted,
      scheduledPaymentsFailed,
      accrued,
      alreadyAccrued,
      skipped,
    };
  });
}
