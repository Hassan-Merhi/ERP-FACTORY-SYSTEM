import { eq } from "drizzle-orm";
import { companySettings } from "@shared/schema";

import { db, type DatabaseOrTransaction } from "../../db";
import { getCompanyBusinessDate } from "../../lib/dateUtils";

/**
 * Today's business date (YYYY-MM-DD) of a company: its configured timezone
 * (company_settings.timezone), UTC when none is set (getCompanyBusinessDate).
 * Used for voucher dates written "today" and as the default as-of date of the
 * "latest rate" lookups, which never use a rate dated after it (wave 17 C).
 */
export async function companyBusinessDate(companyId: number, executor: DatabaseOrTransaction = db): Promise<string> {
  const [settings] = await executor
    .select({ timezone: companySettings.timezone })
    .from(companySettings)
    .where(eq(companySettings.companyId, companyId))
    .limit(1);
  return getCompanyBusinessDate(settings?.timezone);
}
