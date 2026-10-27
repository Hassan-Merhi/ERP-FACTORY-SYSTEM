/**
 * Read-only is enforced at the API boundary, not just by disabled controls.
 * All authenticated business mutations are denied for the active View Only
 * company role. Only transport/session lifecycle operations are exempt.
 */
const AUTH_LIFECYCLE_WRITES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/set-company",
  "POST /api/auth/confirm-password",
  "POST /api/auth/passkey/authenticate/options",
  "POST /api/auth/passkey/authenticate/verify",
]);

const PASSIVE_LIFECYCLE_WRITES = new Set([
  "PATCH /api/user-presence",
  "DELETE /api/user-presence",
  "POST /api/user-presence/leave",
  "POST /api/screen-feed",
  "POST /api/screen-feed/pointer",
  "POST /api/screen-feed/control/tab-heartbeat",
]);

function isPassiveScreenControlResponse(method: string, path: string): boolean {
  if (method !== "POST") return false;
  return (
    /^\/api\/screen-feed\/control\/sessions\/[^/]+\/commands\/[^/]+\/result$/.test(path) ||
    /^\/api\/screen-feed\/control\/sessions\/[^/]+\/keyboard-commands\/[^/]+\/result$/.test(path) ||
    /^\/api\/screen-feed\/control\/sessions\/[^/]+\/stop$/.test(path)
  );
}

export function isViewOnlyWriteBlocked(role: string | null | undefined, methodInput: string, path: string): boolean {
  if (role !== "View Only") return false;
  const method = methodInput.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if (path !== "/api" && !path.startsWith("/api/")) return false;
  if (AUTH_LIFECYCLE_WRITES.has(`${method} ${path}`)) return false;
  if (PASSIVE_LIFECYCLE_WRITES.has(`${method} ${path}`)) return false;
  if (isPassiveScreenControlResponse(method, path)) return false;
  return true;
}
