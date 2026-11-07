/**
 * Permissions Control Center V2 — frontend page catalog.
 *
 * One typed list of the business pages in ERP, Factory, POS/Retail, Properties
 * and Supplier Partner, the permission-controlled actions each page offers,
 * and how the page is gated for the two roles that can never change existing
 * records (View Only and Create Only).
 *
 * The catalog is presentation policy only. The server's global View Only and
 * Create Only guards, the per-route Create Only guards and every other backend
 * boundary stay authoritative; nothing here grants access.
 *
 * Route modes for read-only roles:
 * - "browse": the page reads data; it stays open. In-page controls are gated
 *   per `inPage` below.
 * - "change": the page exists to change existing records (edit, import,
 *   approve, finalize, repair, settings). View Only and Create Only see an
 *   explanation instead, or are sent to the read-only view in `readView`.
 * - "create": the page exists to create a new record. Create Only sees an
 *   explanation unless `createOnlyCreate` names a handler-verified create.
 *   View Only keeps its existing (legacy) behaviour: the page opens and the
 *   server refuses the write.
 *
 * The rows live in config/permissions-v2-page-catalog.json (with the page
 * names and review notes used only by the audit report) and are validated
 * here when the module loads.
 *
 * In-page gating status (`inPage`):
 * - "component": the listed files read the shared role helpers and hide or
 *   disable controls that change existing records (checked by tests).
 * - "route": the whole page is unavailable to read-only roles.
 * - "role_restricted": the route only renders for Admin/Owner/Developer.
 * - "server_enforced": the page still shows some change controls to
 *   read-only roles; the server refuses them and the client request guard
 *   explains the refusal before sending. Listed as remaining UI work.
 */
import pageCatalog from "../config/permissions-v2-page-catalog.json";
import {
  ACCESS_CONTROL_ACTIONS,
  ACCESS_CONTROL_RESOURCES,
  type AccessControlAction,
  type AccessControlResource,
} from "./accessControlV2";
import {
  isCreateOnlyRole,
  isExistingRecordReadOnlyRole,
  isCreateOnlyVerifiedCreateName,
  type CreateOnlyVerifiedCreateName,
} from "./createOnlyRolePolicy";

export type PermissionPageArea = "erp" | "factory" | "pos_retail" | "properties" | "supplier_partner";
export type ReadOnlyRouteMode = "browse" | "change" | "create";
export type InPageGating = "component" | "route" | "role_restricted" | "server_enforced";

export interface PermissionPageEntry {
  id: string;
  area: PermissionPageArea;
  /** wouter-style patterns; `:name` matches one path segment. */
  paths: readonly string[];
  resource: AccessControlResource;
  /** Permission-controlled actions the page offers to some role. */
  actions: readonly AccessControlAction[];
  mode: ReadOnlyRouteMode;
  inPage: InPageGating;
  /** Files whose controls are gated; required when inPage is "component". */
  files?: readonly string[];
  /** Handler-verified create this page submits to (Create Only may open it). */
  createOnlyCreate?: CreateOnlyVerifiedCreateName;
  /** Read-only view for "change" pages: `:param` values are copied across. */
  readView?: string;
}

const ACTIONS: ReadonlySet<string> = new Set(ACCESS_CONTROL_ACTIONS);
const RESOURCES: ReadonlySet<string> = new Set(ACCESS_CONTROL_RESOURCES);
const AREAS: ReadonlySet<string> = new Set(["erp", "factory", "pos_retail", "properties", "supplier_partner"]);
const MODES: ReadonlySet<string> = new Set(["browse", "change", "create"]);
const GATING: ReadonlySet<string> = new Set(["component", "route", "role_restricted", "server_enforced"]);

type RawPage = Record<string, unknown>;

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

/** Validate one catalog row; a malformed row is a build-time error, not a silent gap. */
function parsePage(raw: RawPage): PermissionPageEntry {
  const id = typeof raw.id === "string" ? raw.id : "";
  const paths = stringList(raw.paths);
  const actions = stringList(raw.actions);
  const files = raw.files === undefined ? undefined : stringList(raw.files);
  if (
    !id ||
    !AREAS.has(String(raw.area)) ||
    !paths?.length ||
    !paths.every((path) => path.startsWith("/")) ||
    !RESOURCES.has(String(raw.resource)) ||
    !actions?.length ||
    !actions.every((action) => ACTIONS.has(action)) ||
    !MODES.has(String(raw.mode)) ||
    !GATING.has(String(raw.inPage)) ||
    files === null ||
    (raw.inPage === "component" && !files?.length) ||
    (raw.createOnlyCreate !== undefined && !isCreateOnlyVerifiedCreateName(String(raw.createOnlyCreate))) ||
    (raw.readView !== undefined && (typeof raw.readView !== "string" || !raw.readView.startsWith("/")))
  ) {
    throw new Error("permission_page_catalog_invalid", { cause: id || JSON.stringify(raw).slice(0, 80) });
  }
  return {
    id,
    area: raw.area as PermissionPageArea,
    paths,
    resource: raw.resource as AccessControlResource,
    actions: actions as AccessControlAction[],
    mode: raw.mode as ReadOnlyRouteMode,
    inPage: raw.inPage as InPageGating,
    ...(files ? { files } : {}),
    ...(raw.createOnlyCreate !== undefined
      ? { createOnlyCreate: raw.createOnlyCreate as CreateOnlyVerifiedCreateName }
      : {}),
    ...(typeof raw.readView === "string" ? { readView: raw.readView } : {}),
  };
}

export const PERMISSION_PAGE_CATALOG: readonly PermissionPageEntry[] = (pageCatalog.pages as unknown as RawPage[]).map(
  parsePage
);

function splitPath(path: string): string[] {
  const clean = (path.split(/[?#]/, 1)[0] ?? "").replace(/\/+$/, "");
  return clean === "" ? [] : clean.split("/").slice(1);
}

/** Match a location against a pattern; returns captured params or null. */
export function matchPagePattern(pattern: string, location: string): Record<string, string> | null {
  const want = splitPath(pattern);
  const have = splitPath(location);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < want.length; index += 1) {
    const segment = want[index]!;
    const actual = have[index]!;
    if (segment.startsWith(":")) {
      if (!actual) return null;
      params[segment.slice(1)] = actual;
    } else if (segment !== actual) {
      return null;
    }
  }
  return params;
}

export function findPermissionPage(
  location: string
): { entry: PermissionPageEntry; params: Record<string, string>; pattern: string } | null {
  // Literal segments beat parameters: "/vouchers/:id/edit" must not shadow a
  // literal sibling, so prefer the pattern with the fewest parameters.
  let best: { entry: PermissionPageEntry; params: Record<string, string>; pattern: string } | null = null;
  let bestParams = Number.POSITIVE_INFINITY;
  for (const entry of PERMISSION_PAGE_CATALOG) {
    for (const pattern of entry.paths) {
      const params = matchPagePattern(pattern, location);
      if (!params) continue;
      const count = Object.keys(params).length;
      if (count < bestParams) {
        best = { entry, params, pattern };
        bestParams = count;
      }
    }
  }
  return best;
}

export type ReadOnlyRouteDecision =
  | { kind: "allow" }
  | { kind: "redirect"; to: string; pageId: string }
  | { kind: "explain"; reason: "existing_record_change" | "unverified_create"; pageId: string };

/**
 * Route decision for the active company role. Only View Only and Create Only
 * are affected; every other role, and every page not in the catalog, is left
 * to the existing route guards.
 */
export function decideReadOnlyRoleRoute(role: string | null | undefined, location: string): ReadOnlyRouteDecision {
  if (!isExistingRecordReadOnlyRole(role)) return { kind: "allow" };
  const match = findPermissionPage(location);
  if (!match) return { kind: "allow" };
  const { entry, params } = match;
  if (entry.mode === "browse") return { kind: "allow" };
  if (entry.mode === "create") {
    // View Only keeps its legacy create pages (the server refuses the write).
    if (!isCreateOnlyRole(role)) return { kind: "allow" };
    if (isCreateOnlyVerifiedCreateName(entry.createOnlyCreate)) return { kind: "allow" };
    return { kind: "explain", reason: "unverified_create", pageId: entry.id };
  }
  if (entry.readView) {
    const to = entry.readView.replace(/:([A-Za-z]+)/g, (_, name: string) =>
      encodeURIComponent(params[name] ?? Object.values(params)[0] ?? "")
    );
    return { kind: "redirect", to, pageId: entry.id };
  }
  return { kind: "explain", reason: "existing_record_change", pageId: entry.id };
}

export function permissionPageCatalogSummary() {
  const byArea: Record<PermissionPageArea, number> = {
    erp: 0,
    factory: 0,
    pos_retail: 0,
    properties: 0,
    supplier_partner: 0,
  };
  const byInPage: Record<InPageGating, number> = { component: 0, route: 0, role_restricted: 0, server_enforced: 0 };
  let routes = 0;
  for (const entry of PERMISSION_PAGE_CATALOG) {
    byArea[entry.area] += 1;
    byInPage[entry.inPage] += 1;
    routes += entry.paths.length;
  }
  return { pages: PERMISSION_PAGE_CATALOG.length, routes, byArea, byInPage };
}
