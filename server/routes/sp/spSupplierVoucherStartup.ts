import { runWithDatabaseMaintenanceScope } from "../../services/security/databaseScopeRuntimeContext";
import { ensureSpSupplierVoucherSyncTrigger } from "./spSupplierVoucherSync";

type SpSupplierVoucherStartupDependencies = {
  ensureTrigger: () => Promise<void>;
  runMaintenanceScope: (reason: string, callback: () => Promise<void>) => Promise<void>;
};

const defaultDependencies: SpSupplierVoucherStartupDependencies = {
  ensureTrigger: ensureSpSupplierVoucherSyncTrigger,
  runMaintenanceScope: (reason, callback) => runWithDatabaseMaintenanceScope(reason, callback),
};

/**
 * Installs the Supplier Partner voucher-link trigger at startup (DDL only),
 * with an explicit maintenance identity.
 *
 * Wave 16 (A): startup no longer repairs voucher supplier links. The repair
 * rewrote supplier_id on posted vouchers and lines of every company in
 * maintenance scope with no audit. Mismatches are listed by the integrity
 * diagnostic and repaired only through the Owner preview/apply
 * (GET /api/sp/admin/supplier-voucher-links/plan, POST …/apply).
 */
export async function runSpSupplierVoucherStartup(
  dependencies: SpSupplierVoucherStartupDependencies = defaultDependencies
): Promise<void> {
  await dependencies.runMaintenanceScope("sp-supplier-voucher-sync-startup", async () => {
    await dependencies.ensureTrigger();
  });
}
