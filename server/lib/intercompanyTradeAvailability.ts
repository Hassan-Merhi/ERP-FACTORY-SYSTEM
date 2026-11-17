import { sql } from "drizzle-orm";
import { db } from "../db";
import { resultRows } from "./queryResult";

/**
 * Some live ERP workspaces have not installed the optional intercompany-trading
 * migrations. Tracking and container read APIs must still work for containers
 * belonging to the active company instead of querying a missing relation.
 *
 * The check is read-only and intentionally does not create an intercompany
 * schema or grant any additional company access.
 */
const SCHEMA_CHECK_TTL_MS = 60_000;
let cached: { present: boolean; checkedAt: number } | null = null;
let pending: Promise<boolean> | null = null;

export async function hasIntercompanyTradesTable(): Promise<boolean> {
  // Tracking polls frequently: avoid running a catalog query for every request,
  // but recheck periodically so applying the migration takes effect automatically.
  if (cached && Date.now() - cached.checkedAt < SCHEMA_CHECK_TTL_MS) return cached.present;
  if (pending) return pending;

  pending = (async () => {
    const result = await db.execute(sql`
      SELECT to_regclass('public.intercompany_trades') IS NOT NULL AS "present"
    `);
    const [row] = resultRows<{ present: boolean }>(result);
    const present = row?.present === true;
    cached = { present, checkedAt: Date.now() };
    return present;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/**
 * Normal Payment/Receipt voucher previews run in all ERP companies, including
 * installations where the optional intercompany trading migrations have not
 * been applied. Absence of the policy table is NOT a broken ordinary voucher.
 *
 * Only cache a positive check: if the migration is installed later, the next
 * request must immediately start enforcing verified intercompany mappings.
 * Unexpected catalog/database errors propagate so they cannot bypass controls.
 */
let voucherPolicyTablePresent = false;
let voucherPolicyTableCheck: Promise<boolean> | null = null;

export async function hasIntercompanyVoucherPoliciesTable(): Promise<boolean> {
  if (voucherPolicyTablePresent) return true;
  if (voucherPolicyTableCheck) return voucherPolicyTableCheck;

  voucherPolicyTableCheck = (async () => {
    const result = await db.execute(sql`
      SELECT to_regclass('public.intercompany_relationship_policies') IS NOT NULL AS "present"
    `);
    const [row] = resultRows<{ present: boolean }>(result);
    voucherPolicyTablePresent = row?.present === true;
    return voucherPolicyTablePresent;
  })();
  try {
    return await voucherPolicyTableCheck;
  } finally {
    voucherPolicyTableCheck = null;
  }
}
