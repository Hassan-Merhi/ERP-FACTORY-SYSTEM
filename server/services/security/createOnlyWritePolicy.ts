/**
 * Phase 3 fail-closed outer boundary for Create Only.
 *
 * No candidate route grants access. Each allowed write MUST also have a
 * handler-verified requireVerifiedBusinessAction guard. Keep this allowlist
 * exact: method + literal path, not a prefix or an HTTP verb guess.
 */
import { isViewOnlyWriteBlocked } from "./viewOnlyWritePolicy";

/**
 * Handler-verified creates, by name. Each name has a matching per-route guard
 * in createOnlyVerifiedCreates.ts that is installed on the route itself; a
 * signature listed here without that guard fails the release tests.
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

const HANDLER_VERIFIED_CREATES: ReadonlySet<string> = new Set(
  Object.values(CREATE_ONLY_VERIFIED_CREATE_SIGNATURES).flat()
);

export function isCreateOnlyVerifiedCreate(methodInput: string, path: string): boolean {
  return HANDLER_VERIFIED_CREATES.has(`${methodInput.toUpperCase()} ${path}`);
}

export function isCreateOnlyWriteBlocked(role: string | null | undefined, methodInput: string, path: string): boolean {
  if (role !== "Create Only") return false;
  const method = methodInput.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  // Routing is case-sensitive (server/httpApp.ts), so a differently-cased
  // /API path is not a route. Still treat any casing as an API write here, so
  // this boundary never depends on that setting: only the exact lower-case
  // verified signature below can pass.
  const lowerPath = path.toLowerCase();
  if (lowerPath !== "/api" && !lowerPath.startsWith("/api/")) return false;
  // Preserve exact authentication/presence transport exceptions from the
  // hardened View Only boundary; none constitutes a business mutation.
  if (!isViewOnlyWriteBlocked("View Only", method, lowerPath)) return false;
  return !HANDLER_VERIFIED_CREATES.has(`${method} ${path}`);
}
