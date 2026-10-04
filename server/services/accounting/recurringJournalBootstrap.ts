import { and, eq } from "drizzle-orm";
import { vouchers } from "@shared/schema";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { runWithDatabaseMaintenanceScope } from "../security/databaseScopeRuntimeContext";
import { upsertRecurringJournalFromVoucher } from "./recurringJournalService";

const BOOTSTRAP_COMPANY_ID_ENV = "RECURRING_JOURNAL_BOOTSTRAP_COMPANY_ID";
const BOOTSTRAP_VOUCHER_NUMBER_ENV = "RECURRING_JOURNAL_BOOTSTRAP_VOUCHER_NUMBER";
const BOOTSTRAP_TIMEZONE_ENV = "RECURRING_JOURNAL_BOOTSTRAP_TIMEZONE";

/**
 * Optional one-shot production bootstrap for a known existing Journal voucher.
 *
 * This exists so an already-posted voucher can be converted to a recurring
 * template during deployment without bypassing the normal accounting service.
 * Leave the environment variables unset during normal operation.
 */
export async function bootstrapRecurringJournalFromEnvironment(): Promise<void> {
  const voucherNumber = process.env[BOOTSTRAP_VOUCHER_NUMBER_ENV]?.trim();
  const rawCompanyId = process.env[BOOTSTRAP_COMPANY_ID_ENV]?.trim();

  if (!voucherNumber && !rawCompanyId) return;

  const companyId = Number(rawCompanyId);
  if (!voucherNumber || !Number.isInteger(companyId) || companyId <= 0) {
    logger.error("[startup] Recurring journal bootstrap configuration is incomplete", {
      module: "accounting",
      action: "bootstrapRecurringJournalFromEnvironment",
      hasVoucherNumber: Boolean(voucherNumber),
      companyId: rawCompanyId || null,
    });
    return;
  }

  const timezone = process.env[BOOTSTRAP_TIMEZONE_ENV]?.trim() || "UTC";

  try {
    await runWithDatabaseMaintenanceScope("startup:recurring-journal-bootstrap", async () => {
      const [voucher] = await db
        .select({
          id: vouchers.id,
          companyId: vouchers.companyId,
          deletedAt: vouchers.deletedAt,
        })
        .from(vouchers)
        .where(and(eq(vouchers.companyId, companyId), eq(vouchers.voucherNumber, voucherNumber)))
        .limit(1);

      if (!voucher || voucher.deletedAt) {
        logger.error("[startup] Recurring journal bootstrap voucher was not found", {
          module: "accounting",
          action: "bootstrapRecurringJournalFromEnvironment",
          companyId,
          voucherNumber,
        });
        return;
      }

      const recurring = await upsertRecurringJournalFromVoucher({
        companyId,
        sourceVoucherId: voucher.id,
        userId: null,
        timezone,
      });

      logger.info("[startup] ✓ Recurring journal bootstrap completed", {
        module: "accounting",
        action: "bootstrapRecurringJournalFromEnvironment",
        companyId,
        voucherNumber,
        recurringJournalId: recurring.id,
        nextRunDate: recurring.nextRunDate,
        timezone: recurring.timezone,
      });
    });
  } catch (error: unknown) {
    logger.error("[startup] Recurring journal bootstrap failed", {
      module: "accounting",
      action: "bootstrapRecurringJournalFromEnvironment",
      companyId,
      voucherNumber,
      error,
    });
  }
}
