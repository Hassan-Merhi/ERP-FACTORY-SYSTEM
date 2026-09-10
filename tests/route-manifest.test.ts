import fs from "node:fs";
import path from "node:path";
import express from "express";
import { beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "../server/routes";
import {
  ROUTE_MANIFEST_FORMAT_VERSION,
  diffManifestEntries,
  extractRouteManifest,
  serializeRouteManifest,
  type SerializedRouteManifest,
} from "./helpers/routeManifest";

interface RouteManifestReplacement {
  expected: string;
  actual: string;
}

interface RatchetAllowances {
  routeManifestAdditions: string[];
  routeManifestMountAdditions: string[];
  routeManifestReplacements?: RouteManifestReplacement[];
}

const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const ALLOWANCES_PATH = path.join(process.cwd(), "config/ci-ratchet-allowances.json");
const shouldUpdate = process.env.UPDATE_ROUTE_MANIFEST === "1";
const allowances = JSON.parse(fs.readFileSync(ALLOWANCES_PATH, "utf8")) as RatchetAllowances;
const reviewedSpMounts: string[] = [];
// Raised from 152 when the route manifest was refreshed on 2026-08-05. Most of the increase is
// deliberate layering: language-specific readers (factoryFrenchCatalogReadRoutes) and permission
// guards (permissionBoundaryRoutes) register the same path ahead of the general handler and call
// next(), which this counter cannot distinguish from a genuine duplicate.
//
// Phase 5 raises the reviewed ceiling by one for locationWhatsappLegacyCompatibilityRoutes. That
// route intentionally handles only legacy PATCH /api/locations/:locationId requests carrying a
// WhatsApp destination and calls next("route") for normal location edits, so the generic CRUD route
// remains reachable while legacy WhatsApp writes pass through the new permission/group-validation
// boundary.
//
// It is not all benign. POST /api/stock-transfer-revisions/:id/approve has three separate terminal
// handlers - vouchers/immutableStockTransferRevisionRoutes.ts, vouchers/stockTransferRevisionLifecycleRoutes.ts
// and fiscal-transfers/revisions-write.ts - and Express resolves first-match, so two are dead code.
// The same pattern covers POST /api/stock-transfers/:transferId/revisions. Deciding which
// implementation is authoritative changes stock-transfer approval behavior, so it is deliberately
// left for the audit phase that targets duplicate route registrations rather than folded into a
// CI-unblocking change. Tracked as a confirmed finding, not an accepted one.
// Golden Coast's Fresh Start payment boundary adds one reviewed layered registration.
// #1206 adds a second: goldenCoastPosSettlementDeleteRoute is mounted ahead of the generic
// DELETE /api/vouchers/:id so a Golden Coast POS cash settlement deletes its cascade before
// the generic handler's edit-lock rejects it. The shadow is the mechanism, not an oversight -
// the specific route calls next() for anything that is not a linked GC cash-settlement delete.
// registerChargeLedgerPrerequisite adds two more of the same reviewed kind: a POST and a
// PATCH on /api/factory/customer-orders/:id/charges are mounted ahead of the legacy
// handlers so a VERIFIED/PENDING charge cannot be saved before its customer owns a ledger
// account. ensureCustomerLedgerForChargeWrite calls next() on every path, so the earlier
// registration is a prerequisite the request passes through, not a terminal handler that
// makes the real one dead code.
const MAX_SHADOWED_REGISTRATIONS = 163;
let actual: SerializedRouteManifest;

async function buildManifest(): Promise<SerializedRouteManifest> {
  const app = express();
  const capturedApp = app as unknown as {
    use: (...args: unknown[]) => unknown;
    router?: { stack?: Array<{ mountPath?: string }> };
    _router?: { stack?: Array<{ mountPath?: string }> };
  };
  const originalUse = capturedApp.use.bind(app);
  capturedApp.use = (...args: unknown[]) => {
    const first = args[0];
    const mountPath = typeof first === "string" ? first : first instanceof RegExp ? `re:${first.source}` : "/";
    const stack = capturedApp.router?.stack ?? capturedApp._router?.stack;
    const before = stack?.length ?? 0;
    const result = originalUse(...args);
    const updatedStack = capturedApp.router?.stack ?? capturedApp._router?.stack;
    for (const layer of updatedStack?.slice(before) ?? []) {
      layer.mountPath = mountPath;
    }
    return result;
  };
  const server = await registerRoutes(app);
  server.close();
  return serializeRouteManifest(extractRouteManifest(app));
}

// The screen-feed routes gained a middleware wrapper before the snapshot could be refreshed, and
// this shim let the old snapshot keep matching. The 2026-08-05 regeneration records their real
// handler chains, so entries are now compared exactly - a wrapper appearing or disappearing should
// show up as a diff rather than be normalized away.
function normalizeReviewedMiddlewareWrappers(entry: string): string {
  return entry;
}

function describeDiff(label: string, expectedEntries: string[], actualEntries: string[]): string {
  const { added, removed, reordered } = diffManifestEntries(expectedEntries, actualEntries);
  const lines: string[] = [];
  if (removed.length)
    lines.push(
      `${label} removed (${removed.length}) - these no longer resolve:`,
      ...removed.map((entry) => `  - ${entry}`)
    );
  if (added.length) lines.push(`${label} added (${added.length}):`, ...added.map((entry) => `  + ${entry}`));
  if (reordered) {
    const index = expectedEntries.findIndex((entry, i) => entry !== actualEntries[i]);
    lines.push(
      label + " reordered - membership is unchanged but registration order moved.",
      "Express resolves first-match, so this can change which handler wins.",
      `  first divergence at index ${index}:`,
      `    expected: ${expectedEntries[index]}`,
      `    actual:   ${actualEntries[index]}`
    );
  }
  if (!lines.length) return "";
  lines.push(
    "",
    "If this change is intentional, regenerate with:",
    "  UPDATE_ROUTE_MANIFEST=1 npm run test:backend -- route-manifest"
  );
  return lines.join("\n");
}

function applyReviewedReplacements(entries: string[], replacements: RouteManifestReplacement[]): string[] {
  const remaining = replacements.map((replacement) => ({
    ...replacement,
    remaining: 1,
  }));
  return entries.map((rawEntry) => {
    const entry = normalizeReviewedMiddlewareWrappers(rawEntry);
    const replacement = remaining.find((candidate) => candidate.remaining > 0 && candidate.actual === entry);
    if (!replacement) return entry;
    replacement.remaining -= 1;
    return replacement.expected;
  });
}

function removeReviewedOccurrences(
  entries: string[],
  expectedEntries: string[],
  reviewedEntries: Set<string>
): string[] {
  const remainingReviewed = new Map([...reviewedEntries].map((entry) => [entry, 1] as const));
  const normalized: string[] = [];
  let expectedIndex = 0;
  for (const rawEntry of entries) {
    const entry = normalizeReviewedMiddlewareWrappers(rawEntry);
    if (entry === expectedEntries[expectedIndex]) {
      normalized.push(entry);
      expectedIndex += 1;
      continue;
    }
    const remaining = remainingReviewed.get(entry) ?? 0;
    if (remaining > 0) {
      remainingReviewed.set(entry, remaining - 1);
      continue;
    }
    normalized.push(entry);
  }
  return normalized;
}

describe("route manifest", () => {
  beforeAll(async () => {
    actual = await buildManifest();
    if (shouldUpdate) {
      fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
      fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    }
  });

  it("has a committed snapshot to compare against", () => {
    expect(fs.existsSync(MANIFEST_PATH), "config/route-manifest.json is missing").toBe(true);
  });
  it("registers a non-trivial number of routes", () => expect(actual.routeCount).toBeGreaterThan(500));
  it("exposes no route without an identifiable handler chain", () => {
    expect(actual.routes.filter((entry) => entry.endsWith("[]"))).toEqual([]);
  });
  it("matches the committed snapshot plus exact reviewed deltas", () => {
    const expected = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as SerializedRouteManifest;
    const reviewedRoutes = new Set(allowances.routeManifestAdditions);
    const reviewedMounts = new Set([...allowances.routeManifestMountAdditions, ...reviewedSpMounts]);
    const reviewedReplacements = allowances.routeManifestReplacements ?? [];
    const replacedRoutes = applyReviewedReplacements(actual.routes, reviewedReplacements);
    const routes = removeReviewedOccurrences(replacedRoutes, expected.routes, reviewedRoutes);
    const mounts = removeReviewedOccurrences(actual.middlewareMounts, expected.middlewareMounts, reviewedMounts);
    expect(expected.formatVersion).toBe(ROUTE_MANIFEST_FORMAT_VERSION);
    const routeDiff = describeDiff("Routes", expected.routes, routes);
    expect(routeDiff, routeDiff).toBe("");
    for (const addition of reviewedRoutes) {
      const baselineCount = expected.routes.filter((entry) => entry === addition).length;
      const actualCount = actual.routes
        .map(normalizeReviewedMiddlewareWrappers)
        .filter((entry) => entry === addition).length;
      expect(actualCount).toBe(baselineCount + 1);
    }
    const normalizedActualRoutes = actual.routes.map(normalizeReviewedMiddlewareWrappers);
    for (const replacement of reviewedReplacements) {
      expect(replacement.actual).not.toBe(replacement.expected);
      const baselineExpectedCount = expected.routes.filter((entry) => entry === replacement.expected).length;
      const baselineActualCount = expected.routes.filter((entry) => entry === replacement.actual).length;
      const currentExpectedCount = normalizedActualRoutes.filter((entry) => entry === replacement.expected).length;
      const currentActualCount = normalizedActualRoutes.filter((entry) => entry === replacement.actual).length;
      expect(currentExpectedCount).toBe(baselineExpectedCount - 1);
      expect(currentActualCount).toBe(baselineActualCount + 1);
    }
    const mountDiff = describeDiff("Middleware mounts", expected.middlewareMounts, mounts);
    expect(mountDiff, mountDiff).toBe("");
    for (const addition of reviewedMounts) {
      const baselineCount = expected.middlewareMounts.filter((entry) => entry === addition).length;
      expect(actual.middlewareMounts.filter((entry) => entry === addition).length).toBe(baselineCount + 1);
    }
    expect(actual.routeCount).toBe(expected.routeCount + reviewedRoutes.size);
    expect(actual.middlewareMountCount).toBe(expected.middlewareMountCount + reviewedMounts.size);
  });
  it("does not add shadowed route registrations", () => {
    const counts = new Map<string, number>();
    for (const entry of actual.routes) {
      const key = entry.slice(0, entry.lastIndexOf("[")).trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let shadowed = 0;
    for (const count of counts.values()) shadowed += count - 1;
    expect(
      shadowed,
      `Shadowed registrations rose to ${shadowed} from a baseline of ${MAX_SHADOWED_REGISTRATIONS}.`
    ).toBeLessThanOrEqual(MAX_SHADOWED_REGISTRATIONS);
  });
  it("keeps every /api route behind an explicit guard", () => {
    const snapshot = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as SerializedRouteManifest;
    const publicRoutes = new Set(snapshot.routes.filter((entry) => entry.includes("[<anonymous>]")));
    const unguarded = actual.routes.filter(
      (entry) => entry.includes("[<anonymous>]") && !publicRoutes.has(normalizeReviewedMiddlewareWrappers(entry))
    );
    expect(unguarded).toEqual([]);
  });
});
