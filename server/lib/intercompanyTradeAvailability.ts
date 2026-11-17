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
export async function hasIntercompanyTradesTable(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT to_regclass('public.intercompany_trades') IS NOT NULL AS "present"
  `);
  const [row] = resultRows<{ present: boolean }>(result);
  return row?.present === true;
}
