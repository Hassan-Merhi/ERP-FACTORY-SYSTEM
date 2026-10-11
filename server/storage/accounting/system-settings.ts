import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";

export async function getSystemSetting(key: string): Promise<schema.SystemSetting | undefined> {
  const [setting] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key));
  return setting;
}

export async function setSystemSetting(key: string, value: string | null): Promise<schema.SystemSetting> {
  const existing = await getSystemSetting(key);
  if (existing) {
    const [updated] = await db
      .update(schema.systemSettings)
      .set({ value, updatedAt: sql`now()` })
      .where(eq(schema.systemSettings.key, key))
      .returning();
    return updated;
  } else {
    const [created] = await db.insert(schema.systemSettings).values({ key, value }).returning();
    return created;
  }
}

// Phase 26 (MC-7): the parent comes from companies.parent_company_id; the
// global "parentCompanyId" system setting is retired (storage/auth.ts).
export { getParentCompanyId, setParentCompanyId } from "../auth";

// ---------------------------------------------------------------------------
// Spreadsheets
// ---------------------------------------------------------------------------
