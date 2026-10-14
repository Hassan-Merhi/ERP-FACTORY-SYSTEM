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
