import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

/** The reviewed cost-center migrations, in order. Each one is safe to re-run. */
export const COST_CENTER_MIGRATIONS = [
  "20261021_001_cost_centers_phase1",
  "20261021_002_cost_centers_phase2_integrity",
  "20261021_003_cost_centers_phase5_automation",
  "20261021_004_cost_centers_phase6_budgets",
  "20261021_005_cost_centers_phase7_history",
  "20261021_006_cost_centers_phase8_hardening",
  "20261021_007_cost_centers_historical_batch_size",
] as const;

/**
 * Installs the cost-center tables, triggers and RLS policies. Test files that
 * depend on them must call this themselves: the sharded certification runner
 * orders files round-robin, so no file can rely on another having run first.
 */
export async function applyCostCenterMigrations(pool: Pick<Pool, "query">): Promise<void> {
  for (const tag of COST_CENTER_MIGRATIONS) {
    await pool.query(readFileSync(path.join(__dirname, `../../migrations/${tag}.sql`), "utf8"));
  }
}
