/**
 * Phase 3 fail-closed outer boundary for Create Only.
 *
 * No candidate route grants access. Each allowed write MUST also have a
 * handler-verified requireVerifiedBusinessAction guard. Keep this allowlist
 * exact: method + literal path, not a prefix or an HTTP verb guess.
 */
import { isViewOnlyWriteBlocked } from "./viewOnlyWritePolicy";

const HANDLER_VERIFIED_CREATES = new Set(["POST /api/suppliers"]);

export function isCreateOnlyWriteBlocked(role: string | null | undefined, methodInput: string, path: string): boolean {
  if (role !== "Create Only") return false;
  const method = methodInput.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if (path !== "/api" && !path.startsWith("/api/")) return false;
  // Preserve exact authentication/presence transport exceptions from the
  // hardened View Only boundary; none constitutes a business mutation.
  if (!isViewOnlyWriteBlocked("View Only", method, path)) return false;
  return !HANDLER_VERIFIED_CREATES.has(`${method} ${path}`);
}
