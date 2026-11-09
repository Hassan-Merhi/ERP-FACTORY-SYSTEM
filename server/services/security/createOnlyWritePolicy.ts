/**
 * Phase 3 fail-closed outer boundary for Create Only.
 *
 * No candidate route grants access. Each allowed write MUST also have a
 * handler-verified requireVerifiedBusinessAction guard. Keep this allowlist
 * exact: method + literal path, not a prefix or an HTTP verb guess.
 */
import { isCreateOnlyVerifiedSignature } from "@shared/createOnlyRolePolicy";
import { isViewOnlyWriteBlocked } from "./viewOnlyWritePolicy";

export {
  CREATE_ONLY_VERIFIED_CREATE_SIGNATURES,
  type CreateOnlyVerifiedCreateName,
} from "@shared/createOnlyRolePolicy";

/** Exact handler-verified create signature (shared catalog, see shared/createOnlyRolePolicy.ts). */
export function isCreateOnlyVerifiedCreate(methodInput: string, path: string): boolean {
  return isCreateOnlyVerifiedSignature(methodInput, path);
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
  return !isCreateOnlyVerifiedSignature(method, path);
}
