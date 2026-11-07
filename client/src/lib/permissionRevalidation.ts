/**
 * Prompt permission refresh after the server refuses a request for an access
 * reason, in this tab and in every other open tab of the same browser.
 *
 * Role and permission changes are decided on the server. Role changes already
 * end the person's other sessions; permission-rule and page-access changes do
 * not, so an open tab could keep showing controls the server now refuses until
 * its next poll. When a response carries a permission or role denial, this
 * module refetches the cached access reads (session role, legacy feature
 * permissions, ERP pages, Factory access, locations) and writes a timestamp to
 * localStorage, which fires a `storage` event in the other tabs so they refetch
 * too. Nothing here grants access; it only makes the UI catch up with the
 * server sooner.
 */
import type { QueryClient } from "@tanstack/react-query";
import { ACCESS_API_ENDPOINTS } from "@/lib/queryPolicies";

/** Response codes that mean "your role or permissions no longer allow this". */
export const PERMISSION_DENIAL_CODES: ReadonlySet<string> = new Set([
  "BUSINESS_ACTION_NOT_VERIFIED",
  "BUSINESS_ACTION_DENIED",
  "PERMISSION_REQUIRED",
  "FACTORY_PAGE_ACCESS_DENIED",
  "FACTORY_TAB_ACCESS_DENIED",
  "FACTORY_ROLE_ACCESS_DENIED",
  "FACTORY_COMPANY_ACCESS_REQUIRED",
  "COMPANY_ACCESS_DENIED",
  "TENANT_ACCESS_DENIED",
  "ROLE_NOT_ALLOWED",
  "POS_VIEW_ONLY_WRITE_DENIED",
  "VIEW_ONLY_WRITE_DENIED",
  "ERP_TESTER_SETTINGS_DENIED",
  "SP_PERMISSION_DENIED",
  "PRIVILEGED_MAINTENANCE_ROLE_REQUIRED",
  "PRIVILEGED_MAINTENANCE_PERMISSION_REQUIRED",
]);

/** Query keys whose first element starts with one of these hold access data. */
export const PERMISSION_REVALIDATION_QUERY_PREFIXES: readonly string[] = [
  ...ACCESS_API_ENDPOINTS,
  "/api/auth/me",
  "/api/my-permissions",
  "/api/my-locations",
  "/api/permissions-v2/me",
];

export const PERMISSION_REVALIDATE_STORAGE_KEY = "erp:permissions-revalidate";
const MIN_INTERVAL_MS = 3_000;

/** True for a 403 whose code (or legacy message) is a role/permission denial. */
export function isPermissionDenial(status: number | undefined, code: unknown, message?: unknown): boolean {
  if (status !== 403) return false;
  if (typeof code === "string" && PERMISSION_DENIAL_CODES.has(code)) return true;
  // Older guards answer with a message only (View Only, ERP Tester).
  return (
    typeof message === "string" &&
    (message === "View Only accounts cannot make changes" ||
      message.startsWith("ERP Tester accounts cannot access") ||
      message === "This action is not available to Create Only users.")
  );
}

export function isAccessQueryKey(queryKey: readonly unknown[]): boolean {
  const head = queryKey[0];
  return typeof head === "string" && PERMISSION_REVALIDATION_QUERY_PREFIXES.some((prefix) => head.startsWith(prefix));
}

let lastRevalidation = 0;

function refetchAccess(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    predicate: (query) => isAccessQueryKey(query.queryKey),
    refetchType: "active",
  });
}

/**
 * Refetch access data now and ask other tabs to do the same. Throttled so a
 * burst of refused requests triggers one refresh.
 */
export function requestPermissionRevalidation(queryClient: QueryClient, now: number = Date.now()): boolean {
  if (now - lastRevalidation < MIN_INTERVAL_MS) return false;
  lastRevalidation = now;
  refetchAccess(queryClient);
  try {
    window.localStorage.setItem(PERMISSION_REVALIDATE_STORAGE_KEY, String(now));
  } catch {
    // Storage can be unavailable (private mode); this tab still refreshed.
  }
  return true;
}

/** Follow revalidation requests from other tabs. Returns an unsubscribe. */
export function installPermissionRevalidationListener(queryClient: QueryClient): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PERMISSION_REVALIDATE_STORAGE_KEY || !event.newValue) return;
    refetchAccess(queryClient);
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export function _testOnly_resetPermissionRevalidation(): void {
  lastRevalidation = 0;
}
