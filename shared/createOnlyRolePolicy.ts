/**
 * Create Only role: legacy feature-permission semantics shared by server and client.
 *
 * Create Only reads operational data like View Only and may add verified new
 * records, but it never edits, deletes, approves, voids, reverses, imports,
 * bulk-edits, adjusts or manages users and settings. Those keys are denied
 * here regardless of any stored role_feature_permissions row, so a saved
 * "enabled" toggle can never widen the role. Sensitive money fields are opt-in:
 * they stay hidden until an administrator explicitly enables them.
 *
 * The HTTP write boundary (server/services/security/createOnlyWritePolicy.ts)
 * is still authoritative for every mutation. These rules only stop the UI and
 * read-side permission checks from offering something the server would refuse.
 */
export const CREATE_ONLY_ROLE_NAME = "Create Only" as const;

/** Feature keys Create Only can never hold, whatever is stored for the role. */
export const CREATE_ONLY_ALWAYS_DENIED_FEATURE_KEYS: ReadonlySet<string> = new Set([
  "settings",
  "mod_settings",
  "page_settings",
  "act_void_sale",
  "act_approve_voucher",
  "act_adjust_stock",
  "act_transfer_stock",
  "act_import_data",
  "act_bulk_operations",
  "act_manage_users",
  "act_manage_companies",
  "exp_backup_download",
  "pos_perm_override_price",
  "pos_perm_discount",
  "pos_perm_credit_sale",
  "pos_perm_refund",
  "pos_perm_open_shift",
]);

/** Prefix of sensitive money and cost fields that require an explicit grant. */
export const CREATE_ONLY_OPT_IN_FIELD_PREFIX = "fld_";

export function isCreateOnlyRole(role: string | null | undefined): boolean {
  return role === CREATE_ONLY_ROLE_NAME;
}

/**
 * Decide one legacy feature key for Create Only.
 * `stored` is the role_feature_permissions value for the key, if any.
 */
export function isCreateOnlyFeatureAllowed(featureKey: string, stored: boolean | undefined): boolean {
  if (CREATE_ONLY_ALWAYS_DENIED_FEATURE_KEYS.has(featureKey)) return false;
  if (featureKey.startsWith(CREATE_ONLY_OPT_IN_FIELD_PREFIX)) return stored === true;
  // Pages, modules, tabs, read exports and verified create actions follow the
  // allow-by-default read model used by View Only; an explicit false restricts.
  return stored !== false;
}

/**
 * True for roles that may never change an existing business record: View Only
 * and Create Only. UI code uses it where View Only already hides or disables
 * edit controls; Create Only additionally sees create controls that are
 * explicitly handler-verified on the server.
 */
export function isExistingRecordReadOnlyRole(role: string | null | undefined): boolean {
  return role === "View Only" || role === CREATE_ONLY_ROLE_NAME;
}

/**
 * Handler-verified Create Only creates, by name, with their exact
 * "METHOD /path" signatures. The server's global Create Only guard lets only
 * these business writes through, and each has a named per-route guard
 * (server/services/security/createOnlyVerifiedCreates.ts). The client uses the
 * same catalog to show only the create controls the server will accept.
 */
export const CREATE_ONLY_VERIFIED_CREATE_SIGNATURES = {
  suppliers: ["POST /api/suppliers"],
  customers: ["POST /api/customers"],
  stockItems: ["POST /api/stock-items"],
  factoryBaleBatch: ["POST /api/factory/bales/create-batch"],
  factoryCustomerOrders: ["POST /api/factory/customer-orders"],
  rentalUnits: ["POST /api/properties/rental/units", "POST /api/erp/rental/units", "POST /api/factory/rental/units"],
  rentalContracts: [
    "POST /api/properties/rental/contracts",
    "POST /api/erp/rental/contracts",
    "POST /api/factory/rental/contracts",
  ],
  retailProducts: ["POST /api/retail/products"],
  spSales: ["POST /api/sp/sales"],
} as const;

export type CreateOnlyVerifiedCreateName = keyof typeof CREATE_ONLY_VERIFIED_CREATE_SIGNATURES;

const VERIFIED_SIGNATURES: ReadonlySet<string> = new Set(Object.values(CREATE_ONLY_VERIFIED_CREATE_SIGNATURES).flat());

export function isCreateOnlyVerifiedCreateName(name: string | null | undefined): name is CreateOnlyVerifiedCreateName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(CREATE_ONLY_VERIFIED_CREATE_SIGNATURES, name);
}

/** Exact match of a request against the verified catalog (no prefix, no casing tricks). */
export function isCreateOnlyVerifiedSignature(method: string, path: string): boolean {
  return VERIFIED_SIGNATURES.has(`${method.toUpperCase()} ${path}`);
}
