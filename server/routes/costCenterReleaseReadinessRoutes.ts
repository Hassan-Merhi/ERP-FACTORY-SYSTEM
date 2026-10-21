/**
 * Read-only Phase 8 release-readiness inventory.
 * Inspect structural prerequisites without running CI, migrations, data repairs
 * or financial side effects. Success does NOT replace functional certification.
 */
import type { Express } from "express";
import { pool } from "../db";
import { requireAuth } from "../auth";
import {
  getActiveCompanyPermissionContext,
  ActiveCompanyPermissionContextError,
} from "../services/security/activeCompanyPermissionContext";

const TABLES = [
  "cost_centers",
  "cost_center_allocations",
  "cost_center_auto_rules",
  "cost_center_source_overrides",
  "cost_center_auto_failures",
  "cost_center_monthly_budgets",
  "cost_center_historical_batches",
  "cost_center_historical_batch_items",
];
const TRIGGERS = [
  "cost_centers_guard_hierarchy_trg",
  "cost_center_allocations_guard_trg",
  "cost_center_allocation_eligibility_trg",
  "cost_center_voucher_entry_change_trg",
  "cost_center_voucher_change_trg",
  "cost_center_factory_daybook_change_trg",
  "cost_center_archive_children_trg",
  "cost_center_auto_rules_guard_trg",
  "cost_center_source_override_guard_trg",
  "cost_center_auto_voucher_insert_trg",
  "cost_center_auto_daybook_insert_trg",
  "cost_center_auto_voucher_finalize_trg",
  "cost_center_monthly_budgets_guard_trg",
  "cost_center_historical_batch_guard_trg",
  "cost_center_voucher_entry_delete_trg",
  "cost_center_factory_daybook_delete_trg",
];
const FUNCTIONS = [
  "cost_center_allocation_eligibility_guard",
  "cost_center_auto_apply_voucher_entry",
  "cost_center_auto_apply_factory_daybook",
  "cost_center_auto_record_failure",
  "cost_center_historical_batch_guard",
  "cost_center_voucher_in_reversal_pair",
  "cost_center_clear_stale_source",
  "cost_center_source_delete_notice",
];
const MIGRATION_TAGS = [
  "20261021_001_cost_centers_phase1",
  "20261021_002_cost_centers_phase2_integrity",
  "20261021_003_cost_centers_phase5_automation",
  "20261021_004_cost_centers_phase6_budgets",
  "20261021_005_cost_centers_phase7_history",
  "20261021_006_cost_centers_phase8_hardening",
  "20261021_007_cost_centers_historical_batch_size",
];

/** Fully company-scoped identity; only accounting administrators may inspect deployment structure. */
function register(app: Express, prefix: string): void {
  app.get(prefix + "/release-readiness", requireAuth, async (req, res) => {
    try {
      const context = await getActiveCompanyPermissionContext(req);
      if (!["Admin", "Owner", "Developer"].includes(context.role))
        return res.status(403).json({ message: "Accounting administrator access required" });
      const tables = await pool.query(
        "SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced" +
          " FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace" +
          " WHERE n.nspname='public' AND c.relkind IN ('r','p')" +
          " AND c.relname=ANY($1::text[])",
        [TABLES]
      );
      const triggers = await pool.query(
        "SELECT t.tgname AS name FROM pg_trigger t" +
          " JOIN pg_class c ON c.oid=t.tgrelid" +
          " JOIN pg_namespace n ON n.oid=c.relnamespace" +
          " WHERE n.nspname='public' AND NOT t.tgisinternal" +
          " AND t.tgenabled<>'D' AND t.tgname=ANY($1::text[])",
        [TRIGGERS]
      );
      const functions = await pool.query(
        "SELECT p.proname AS name FROM pg_proc p" +
          " JOIN pg_namespace n ON n.oid=p.pronamespace" +
          " WHERE n.nspname='public' AND p.proname=ANY($1::text[])",
        [FUNCTIONS]
      );
      const tableRows = new Map<string, { name: string; rls: boolean; forced: boolean }>(
        tables.rows.map((x) => [x.name, x])
      );
      const presentTriggers = new Set<string>(triggers.rows.map((x) => x.name));
      const presentFunctions = new Set<string>(functions.rows.map((x) => x.name));
      const tableChecks = TABLES.map((name) => ({
        name,
        exists: tableRows.has(name),
        rlsEnabled: tableRows.get(name)?.rls ?? false,
        forceRls: tableRows.get(name)?.forced ?? false,
      }));
      const missingTriggers = TRIGGERS.filter((name) => !presentTriggers.has(name));
      const missingFunctions = FUNCTIONS.filter((name) => !presentFunctions.has(name));
      const complete =
        tableChecks.every((t) => t.exists && t.rlsEnabled && t.forceRls) &&
        missingTriggers.length === 0 &&
        missingFunctions.length === 0;
      return res.json({
        structuralReady: complete,
        companyId: context.companyId,
        migrationTagsInRequiredOrder: MIGRATION_TAGS,
        tables: tableChecks,
        missingTriggers,
        missingFunctions,
        warning: complete
          ? "Structural prerequisites detected. Functional, permission, FX and accounting regression certification is still required before release."
          : "Database structure incomplete. Do not enable automated cost centers or historical assignments until Claude validates and applies migrations.",
      });
    } catch (error) {
      if (error instanceof ActiveCompanyPermissionContextError)
        return res.status(error.status).json({ message: error.message, code: error.code });
      return res.status(500).json({ message: "Cost center readiness inspection failed" });
    }
  });
}
export function registerCostCenterReleaseReadinessRoutes(app: Express): void {
  register(app, "/api/cost-centers");
  register(app, "/api/factory/cost-centers");
}
