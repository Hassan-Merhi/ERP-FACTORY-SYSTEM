import type { Company } from "@/contexts/CompanyContext";

export type PropertiesCapability = "workspace" | "admin" | "developer" | "personal";
export const PROPERTIES_RENTAL_TABS = [
  { value: "warehouses", label: "Warehouses", path: "/properties/rentals" },
  { value: "shops", label: "Shops", path: "/properties/rentals?tab=shops" },
  { value: "payments", label: "Payments", path: "/properties/rentals?tab=payments" },
] as const;
export type PropertiesRentalTab = (typeof PROPERTIES_RENTAL_TABS)[number]["value"];

type NavEntry = Readonly<{
  path: string;
  label: string;
  parent: string | null;
  capability: PropertiesCapability;
  navigation?: "pinned" | "tab" | "tool" | "footer" | "hidden";
}>;
/** Canonical Properties routes and tab metadata for sidebar/search/route gates. */
export const PROPERTIES_NAVIGATION: readonly NavEntry[] = [
  { path: "/properties/daybook", label: "Daybook", parent: null, capability: "workspace", navigation: "pinned" },
  { path: "/properties/agents", label: "Agent Ledger", parent: null, capability: "workspace", navigation: "pinned" },
  { path: "/properties/rentals", label: "Rentals", parent: null, capability: "workspace", navigation: "pinned" },
  { path: "/properties/rentals?tab=shops", label: "Shops", parent: "/properties/rentals", capability: "workspace", navigation: "tab" },
  { path: "/properties/rentals?tab=payments", label: "Payments", parent: "/properties/rentals", capability: "workspace", navigation: "tab" },
  { path: "/properties/accounts", label: "Accounts", parent: null, capability: "workspace", navigation: "pinned" },
  { path: "/properties/vouchers", label: "Vouchers", parent: null, capability: "workspace", navigation: "pinned" },
  { path: "/properties/analytics", label: "Analytics", parent: null, capability: "workspace", navigation: "pinned" },
  { path: "/properties/help-training", label: "Help & Training", parent: null, capability: "workspace", navigation: "footer" },
  { path: "/properties/my-settings", label: "My Settings", parent: null, capability: "personal", navigation: "footer" },
  { path: "/properties/settings", label: "Settings", parent: null, capability: "admin", navigation: "footer" },
  { path: "/properties/transfer", label: "Cash Transfer", parent: "/properties/rentals", capability: "developer", navigation: "tool" },
  ...["toolbox", "open-items", "cash-bank", "monetary-fx", "rentals", "consolidation", "history", "statements", "fiscal-review", "dashboard", "rollout"].map((name) => ({
    path: `/properties/accounting/${name}`, label: name, parent: "/properties/accounts",
    capability: "developer" as const, navigation: "tool" as const,
  })),
  ...["net-position-details", "deleted-items", "orphaned-records", "chatbot-settings", "import-cycle-diagnostics", "inventory-repair", "company-data-reset", "balance-repair"].map((name) => ({
    path: `/properties/${name}`, label: name, parent: "/properties/settings",
    capability: "admin" as const, navigation: "hidden" as const,
  })),
  { path: "/properties/account-groups", label: "Account Groups", parent: "/properties/accounts", capability: "admin", navigation: "hidden" },
  { path: "/properties/dashboard", label: "Compatibility Dashboard", parent: null, capability: "workspace", navigation: "hidden" },
  { path: "/properties/create", label: "Create Property", parent: "/properties/rentals?tab=warehouses", capability: "workspace", navigation: "hidden" },
  { path: "/properties/vouchers/:id/edit", label: "Edit Voucher", parent: "/properties/vouchers", capability: "workspace", navigation: "hidden" },
  { path: "/properties/voucher-detail/:voucherId", label: "Voucher Detail", parent: "/properties/vouchers", capability: "workspace", navigation: "hidden" },
  { path: "/properties/ledger-monthly/:accountId", label: "Account Ledger", parent: "/properties/accounts", capability: "workspace", navigation: "hidden" },
  { path: "/properties/ledger-vouchers/:accountId/:year/:month", label: "Ledger Vouchers", parent: "/properties/ledger-monthly/:accountId", capability: "workspace", navigation: "hidden" },
];

/** Retain replacement redirects; no history entries should be added. */
export const PROPERTIES_LEGACY_RENTAL_REDIRECTS = {
  "/properties/rental/warehouses": "/properties/rentals",
  "/properties/rental/shops": "/properties/rentals?tab=shops",
  "/properties/rental/payments": "/properties/rentals?tab=payments",
} as const;

/** Resolve a concrete Properties pathname, retaining dynamic ledger/voucher
 * routes and valid rental tab URLs without accepting unrelated prefixes.
 * Hidden compatibility routes are still eligible for direct navigation.
 */
export function findPropertiesNavigationEntry(pathOrUrl: string): NavEntry | undefined {
  const [pathname, query = ""] = pathOrUrl.split("?", 2);
  const decodedPath = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  const queryTab = new URLSearchParams(query).get("tab");
  const candidate = decodedPath === "/properties/rentals" && (queryTab === "shops" || queryTab === "payments")
    ? `/properties/rentals?tab=${queryTab}`
    : decodedPath;
  const exact = PROPERTIES_NAVIGATION.find((entry) => entry.path === candidate);
  if (exact) return exact;
  const segments = decodedPath.split("/");
  return PROPERTIES_NAVIGATION.find((entry) => {
    if (!entry.path.includes("/:")) return false;
    const pattern = entry.path.split("/");
    return pattern.length === segments.length &&
      pattern.every((part, index) => part.startsWith(":")
        ? segments[index].length > 0
        : part === segments[index]);
  });
}

export type PropertiesSessionIdentity = {
  role?: string | null;
  currentRole?: string | null;
};

/**
 * Selected-company assignments take precedence when available, rather than
 * treating a global role as company-wide authorization. UI gates only.
 * The server must still authorize every request in its company session.
 */
export function propertiesEffectiveRole(
  user: PropertiesSessionIdentity | null | undefined,
  selectedCompany: Pick<Company, "companyType" | "role"> | null | undefined,
): string | null {
  if (selectedCompany && selectedCompany.companyType !== "properties") return null;
  return selectedCompany?.role ?? user?.currentRole ?? user?.role ?? null;
}

export function canUsePropertiesCapability(
  capability: PropertiesCapability,
  user: PropertiesSessionIdentity | null | undefined,
  selectedCompany: Pick<Company, "companyType" | "role"> | null | undefined,
): boolean {
  const role = propertiesEffectiveRole(user, selectedCompany);
  if (role === null) return false;
  if (capability === "workspace") return true;
  if (capability === "personal") return role !== "ERP Tester";
  if (capability === "admin") return role === "Admin" || role === "Developer";
  return role === "Developer";
}

export function canNavigateProperties(
  path: string,
  user: PropertiesSessionIdentity | null | undefined,
  company: Pick<Company, "companyType" | "role"> | null | undefined,
): boolean {
  const entry = findPropertiesNavigationEntry(path);
  return entry ? canUsePropertiesCapability(entry.capability, user, company) : false;
}

/**
 * Authoritative Properties deterministic Back/Escape destination.
 * Derive parents from the same manifest used by navigation capabilities.
 * Historical rental aliases keep their existing tab-specific destinations.
 *
 * Older ledger bookmarks can contain a single YYYY-MM segment instead of
 * /:year/:month; both variants return to the matching account ledger.
 * Unknown or malformed paths have no parent.
 */
export function getPropertiesParentRoute(pathOrUrl: string): string | null {
  const pathname = pathOrUrl.split(/[?#]/, 1)[0].replace(/\/$/, "");
  if (!pathname.startsWith("/properties/")) return null;

  if (Object.prototype.hasOwnProperty.call(PROPERTIES_LEGACY_RENTAL_REDIRECTS, pathname)) {
    if (pathname === "/properties/rental/warehouses") return "/properties/rentals?tab=warehouses";
    return PROPERTIES_LEGACY_RENTAL_REDIRECTS[pathname as keyof typeof PROPERTIES_LEGACY_RENTAL_REDIRECTS];
  }

  const entry = findPropertiesNavigationEntry(pathname);
  if (entry?.parent) {
    const matchedAccountId = pathname.match(/^\/properties\/ledger-vouchers\/([^/]+)\/(?:[^/]+\/[^/]+|[^/]+)$/);
    if (entry.path.includes(":accountId") && entry.path.startsWith("/properties/ledger-vouchers/")) {
      return matchedAccountId ? `/properties/ledger-monthly/${matchedAccountId[1]}` : null;
    }
    return entry.parent;
  }

  // One-segment period bookmarks predate the /:year/:month route shape.
  const legacyLedger = pathname.match(/^\/properties\/ledger-vouchers\/([^/]+)\/[^/]+$/);
  if (legacyLedger) return `/properties/ledger-monthly/${legacyLedger[1]}`;
  return null;
}
