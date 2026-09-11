import type { Company, LedgerAccount, Location, UserCompanyRole } from "@shared/schema";

/**
 * Shared contracts for the settings surface (`client/src/pages/settings`).
 *
 * These describe the JSON wire shapes the settings tabs consume so the
 * per-file `: any` annotations they replaced cannot refill. They are
 * intentionally `type` aliases rather than interfaces: several settings
 * components (audit dialog, role tables) accept `Record<string, unknown>`
 * rows, and only object-literal types carry an implicit index signature.
 */

/** Company row as returned by `/api/companies`. */
export type SettingsCompanyRow = Company;

/** Ledger account row as returned by `/api/ledger-accounts`. */
export type SettingsLedgerAccountRow = LedgerAccount;

/** Location row as returned by `/api/locations`. */
export type SettingsLocationRow = Location;

/** Company role assignment as returned by `/api/users/:id/company-roles`. */
export type SettingsUserRoleRow = UserCompanyRole;

/**
 * Enriched user row as returned by `/api/users`. The base `users` table has
 * no role/display/access columns; the API projects them from the user's
 * company roles and restriction tables.
 */
export type SettingsUserRow = {
  id: string;
  username: string;
  displayName?: string | null;
  role?: string | null;
  active?: boolean | null;
  hasErpAccess?: boolean;
  hasFactoryAccess?: boolean;
  pageAccess?: string[];
  hiddenCostFields?: string[];
  hiddenErpCostFields?: string[];
};

/** Role permission row as returned by `/api/settings/role-permissions`. */
export type SettingsRolePermissionRow = {
  role: string;
  featureKey: string;
  enabled: boolean;
};

/** Audit log row as returned by `/api/audit-log` (summary profile). */
export type SettingsAuditLogRow = {
  id: number;
  companyId: number | null;
  userId?: string | null;
  username?: string | null;
  action: string;
  tableName: string;
  moduleLabel?: string | null;
  changeSummary?: string | null;
  recordId?: number | null;
  recordIdentifier?: string | null;
  createdAt: string;
};

/** Login history row as returned by `/api/login-history`. */
export type SettingsLoginHistoryRow = {
  id: number | string;
  username: string;
  companyName?: string | null;
  loginAt: string;
  ipAddress?: string | null;
  city?: string | null;
  country?: string | null;
  userAgent?: string | null;
};

/** Intercompany POS auto-transfer config from `/api/intercompany-pos-config`. */
export type SettingsIntercompanyPosConfig = {
  destCompanyId?: number | null;
  sourceIntercoAccountId?: number | null;
  destIntercoAccountId?: number | null;
  enabled?: boolean;
  skipSourceVoucher?: boolean;
};

/** POS receipt toggles from `/api/settings/pos-receipt`. */
export type SettingsPosReceipt = {
  showLogo: boolean;
  showAddress: boolean;
  showFooter: boolean;
};

/** Mutation acknowledgement carrying a human-readable message. */
export type SettingsMessageResult = {
  message?: string;
};
