// Compatibility barrel — all existing imports from this path continue to work.
// Implementation has been split into focused files under server/routes/helpers/.

// Evaluate the emergency impersonation policy before authRoutes reads
// process.env.MASTER_PASSWORD into its module-level constants.
import "./helpers/masterPasswordPolicy";

export { upload } from "./helpers/uploadHelpers";

export {
  hashPassword,
  isLegacySHA256Hash,
  verifyLegacyPassword,
  verifyPassword,
  verifyPasswordBcryptOnly,
} from "./helpers/passwordHelpers";

export { logAudit } from "./helpers/auditWriteAdapter";
export {
  snapshotVoucherEntries,
  buildVoucherChangesForCreate,
  buildVoucherChangesForDelete,
  buildVoucherChangesForUpdate,
  buildItemLevelChanges,
} from "./helpers/auditHelpers";

export { getCurrentExchangeRate } from "./helpers/exchangeRateHelpers";

export { runIntercompanyPosTransfer, recalculateIntercompanyForDate } from "./helpers/intercompanyHelpers";

export { calculateHistoricalLocationInventory } from "./helpers/inventoryHistoryHelpers";

export { syncEmployeeBalancesFromEntries } from "./helpers/employeeHelpers";

export {
  resolveParentCompanyId,
  isParentCompanyContext,
  getSupplierBalanceForContext,
  authorizeCompanyIdParam,
  ParentCompanyNotConfiguredError,
} from "./helpers/supplierBalanceHelpers";
