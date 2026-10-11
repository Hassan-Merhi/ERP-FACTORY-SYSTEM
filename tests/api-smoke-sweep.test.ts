/**
 * API smoke sweep.
 * ---------------
 * Companion to `api-smoke.test.ts`, which hand-checks response *contracts* for
 * ~30 important endpoints. This file instead checks *liveness* across the whole
 * read surface: every parameterless `GET /api/...` route in the committed route
 * manifest is called once as an authenticated admin and must not return 5xx.
 *
 * Why this exists alongside the route manifest:
 *
 *   - The manifest proves a route is still *registered* after a file split. It
 *     cannot prove the handler still *works* — a helper that moved without
 *     being re-exported, or a circular import that resolves to `undefined` at
 *     call time, registers fine and throws only when the handler executes.
 *   - This sweep executes them, so that class of split damage surfaces
 *     immediately instead of in production.
 *
 * Endpoints that legitimately fail without richer seed data are recorded in
 * `config/api-smoke-baseline.json`. That list is a ratchet: entries may be
 * removed as endpoints are fixed or seeding improves, but adding to it means
 * accepting a known-broken endpoint and requires review.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import type { SerializedRouteManifest } from "./helpers/routeManifest";

const TEST_PREFIX = "sweeptest";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const BASELINE_PATH = path.join(process.cwd(), "config/api-smoke-baseline.json");
const SHAPES_PATH = path.join(process.cwd(), "config/api-smoke-shapes.json");
const shouldUpdateBaseline = process.env.UPDATE_API_SMOKE_BASELINE === "1";
const shouldUpdateShapes = process.env.UPDATE_API_SMOKE_SHAPES === "1";

/**
 * Per-request deadline. Generous enough for the slowest legitimate read on a
 * cold cache, short enough that a hung handler fails the run quickly.
 */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Routes excluded from the sweep. These are skipped because *calling* them is
 * unsafe or wasteful in a test run, not because they are allowed to be broken:
 *
 *   - mutating or long-running maintenance operations,
 *   - file/report generation, which is slow and produces binary payloads,
 *   - debug endpoints, which exist to introspect a running system.
 *
 * Anything excluded here is not protected by this sweep, so keep the list
 * narrow and prefer the baseline for merely-failing endpoints.
 */
const EXCLUDED_PATTERNS: RegExp[] = [
  /(^|\/)(debug)(\/|$)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge)/i,
  /(^|\/)(run|apply|execute|trigger|sync)(\/|$)/i,
  /(export|download|template)/i,
  /\.(xlsx|pdf|csv|zip)$/i,
];

interface SweepFailure {
  route: string;
  status: number;
  detail: string;
}

/** What a route answered, reduced to the parts that form its contract. */
interface SweptResponse {
  status: number;
  shape: string;
}

interface ShapeBaseline {
  description: string;
  regenerate: string;
  /**
   * Routes whose shape varies between identical runs; reported, never asserted.
   *
   * Every entry today is a workbook endpoint. Their bodies parse into an
   * object keyed by byte offset, so the "shape" is thousands of indices that
   * shift whenever the zip container's timestamps change the file's length.
   * They stay in the sweep — liveness is still checked, and net-profit-excel
   * additionally has a real content pin in
   * tests/report-endpoint-characterization.test.ts, which hashes the workbook's
   * cell values rather than its bytes.
   */
  unstable: string[];
  /**
   * Routes that answered 5xx when the baseline was generated, so no contract
   * could be recorded for them.
   *
   * This list is *not* a ratchet and must not be treated as one — whether a
   * route 5xxes here is environment-dependent in exactly the way
   * `config/api-smoke-baseline.json` already documents. Recording a 500's shape
   * would freeze one machine's missing table into a contract every other
   * machine then fails against, so those routes are simply left unpinned. The
   * 5xx assertion above is what covers them.
   */
  skippedFailing: string[];
  routes: Record<string, SweptResponse>;
}

/**
 * A response's structure with its values removed.
 *
 * Scalar leaves collapse to `scalar` rather than their `typeof`, deliberately.
 * A nullable column that is null in one run and a string in the next would
 * otherwise fail the comparison for no reason, and a shape check that cries
 * wolf gets regenerated without being read — the same failure mode the pin
 * harness had to avoid. Key sets, nesting, and object-versus-array are what
 * this is here to protect, and those stay exact.
 */
export function responseShape(value: unknown, depth = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return depth >= 3 ? "[…]" : `[${responseShape(value[0], depth + 1)}]`;
  }
  if (value && typeof value === "object") {
    if (depth >= 3) return "{…}";
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${key}:${responseShape((value as Record<string, unknown>)[key], depth + 1)}`);
    return `{${entries.join(",")}}`;
  }
  return "scalar";
}

/**
 * An empty collection is a legitimate state of the same contract, so `[]` is
 * accepted wherever a populated array was recorded and vice versa. Anything
 * else — a lost key, a renamed field, an object where a list used to be — is a
 * real difference and fails.
 */
export function shapesCompatible(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  const emptied = (shape: string) => shape.replace(/\[[^[\]]*\]/g, "[]");
  return emptied(expected) === emptied(actual);
}

function loadManifest(): SerializedRouteManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as SerializedRouteManifest;
}

/** Parameterless GET /api routes, in manifest order, deduplicated. */
export function selectSweepablePaths(manifest: SerializedRouteManifest): string[] {
  const seen = new Set<string>();
  const selected: string[] = [];

  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (method !== "GET") continue;
    if (!routePath?.startsWith("/api/")) continue;
    // Path parameters would need per-route fixture data to be meaningful.
    if (routePath.includes(":")) continue;
    if (routePath.includes("*")) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;
    if (seen.has(routePath)) continue;

    seen.add(routePath);
    selected.push(routePath);
  }

  return selected;
}

let ctx: TestContext;
let agent: request.SuperAgentTest;
const failures: SweepFailure[] = [];
let sweptPaths: string[] = [];
const observed: Record<string, SweptResponse> = {};

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  sweptPaths = selectSweepablePaths(loadManifest());

  try {
    await sweepAll();
  } finally {
    // Drop this suite's company as soon as the walk finishes rather than in
    // afterAll. Nothing below needs the fixture - the results are already
    // captured in `failures` - and releasing it early keeps the window in which
    // a second ERP company exists as short as possible.
    await cleanupTestData(TEST_PREFIX);
  }

  if (shouldUpdateBaseline) {
    const baseline = {
      description:
        "Endpoints that return 5xx under the smoke sweep's seed data. This list is a " +
        "ratchet: removing entries is progress, adding one accepts a known-broken " +
        "endpoint. Regenerate with UPDATE_API_SMOKE_BASELINE=1.",
      knownFailing: failures.map((failure) => failure.route).sort(),
    };
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  }

  if (shouldUpdateShapes) {
    const existing = loadShapes();
    const routes: Record<string, SweptResponse> = {};
    const skippedFailing: string[] = [];
    for (const routePath of Object.keys(observed).sort()) {
      if (existing.unstable.includes(routePath)) continue;
      if (observed[routePath].status >= 500) {
        skippedFailing.push(routePath);
        continue;
      }
      routes[routePath] = observed[routePath];
    }
    const shapes: ShapeBaseline = {
      description:
        "Status and response structure for every swept GET endpoint, with values removed. " +
        "The sweep proves a handler still answers; this proves it still answers with the same " +
        "contract - a dropped field or a route that starts refusing permission is invisible to " +
        "a non-5xx check. Scalar leaves are collapsed and empty arrays match populated ones, so " +
        "only structural change fails.",
      regenerate: "UPDATE_API_SMOKE_SHAPES=1 npm run test:smoke-sweep",
      unstable: existing.unstable,
      skippedFailing,
      routes,
    };
    fs.writeFileSync(SHAPES_PATH, `${JSON.stringify(shapes, null, 2)}\n`, "utf8");
  }
}, 300000);

function loadShapes(): ShapeBaseline {
  if (!fs.existsSync(SHAPES_PATH)) {
    return { description: "", regenerate: "", unstable: [], skippedFailing: [], routes: {} };
  }
  return JSON.parse(fs.readFileSync(SHAPES_PATH, "utf8")) as ShapeBaseline;
}

async function sweepAll(): Promise<void> {
  for (const routePath of sweptPaths) {
    let status = 0;
    let detail = "";

    try {
      // A handler that throws without answering never ends the response cycle.
      // Without an explicit deadline that hangs the whole suite instead of
      // failing it - which is precisely the damage this sweep exists to catch,
      // so it must surface as a failure, not a stall.
      const response = await agent
        .get(routePath)
        .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
      status = response.status;
      observed[routePath] = { status, shape: responseShape(response.body) };
      if (status >= 500) {
        const body = response.body as { message?: string; error?: string } | undefined;
        detail = body?.message || body?.error || response.text?.slice(0, 200) || "";
      }
    } catch (error) {
      const timedOut = Boolean((error as { timeout?: unknown } | undefined)?.timeout);
      status = timedOut ? 598 : 599;
      detail = timedOut
        ? `No response within ${REQUEST_TIMEOUT_MS}ms - the handler likely threw without answering.`
        : error instanceof Error
          ? error.message
          : String(error);
    }

    if (status >= 500) failures.push({ route: routePath, status, detail });
  }
}

afterAll(async () => {
  // The fixture is already removed at the end of beforeAll; this is a safety
  // net for the case where seeding itself failed part-way. cleanupTestData is
  // idempotent.
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("API smoke sweep", () => {
  it("sweeps a broad slice of the read surface", () => {
    // Guards against the selection silently collapsing to nothing, which would
    // make the 5xx assertion below vacuous.
    expect(sweptPaths.length).toBeGreaterThan(250);
  });

  it("returns no unexpected 5xx across swept GET endpoints", () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as {
      knownFailing: string[];
    };
    const known = new Set(baseline.knownFailing);

    const unexpected = failures.filter((failure) => !known.has(failure.route));
    const report = unexpected
      .map((failure) => `  ${failure.status} ${failure.route}\n      ${failure.detail}`)
      .join("\n");

    expect(
      unexpected,
      `Unexpected 5xx responses (${unexpected.length}).\n` +
        "A split that moved a handler without its dependencies looks exactly like this.\n" +
        `${report}\n`
    ).toEqual([]);
  });

  it("keeps every swept endpoint's status and response structure", () => {
    const shapes = loadShapes();
    const unstable = new Set(shapes.unstable);
    const knownFailing = new Set(
      (JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as { knownFailing: string[] }).knownFailing
    );

    const drifted = Object.entries(shapes.routes)
      .filter(([routePath]) => !unstable.has(routePath) && observed[routePath])
      .map(([routePath, expected]) => ({ routePath, expected, actual: observed[routePath] }))
      .filter(
        ({ routePath, expected, actual }) =>
          actual.status < 500 &&
          (expected.status !== actual.status || !shapesCompatible(expected.shape, actual.shape)) &&
          !knownFailing.has(routePath)
      )
      .map(
        ({ routePath, expected, actual }) =>
          `  ${routePath}\n      status ${expected.status} -> ${actual.status}\n` +
          `      shape  ${expected.shape}\n          ->  ${actual.shape}`
      );

    // The non-5xx check above cannot see a handler that quietly drops a field,
    // renames one, or starts answering 403 - all of which break a client just
    // as thoroughly as a crash. This is the sweep's contract half.
    expect(
      drifted,
      `${drifted.length} swept endpoint(s) changed their response contract.\n` +
        `If the change was deliberate, regenerate with: ${shapes.regenerate}\n${drifted.join("\n")}\n`
    ).toEqual([]);
  });

  it("has a recorded contract for most of the swept surface", () => {
    const shapes = loadShapes();
    const recorded = Object.keys(shapes.routes).filter((routePath) => sweptPaths.includes(routePath));

    // Guards the check above from going vacuous: if the baseline emptied out,
    // or selection drifted away from it, every comparison would silently pass.
    // The margin allows for the handful of routes left unpinned because they
    // 5xx on the machine that generated the baseline.
    expect(recorded.length).toBeGreaterThan(sweptPaths.length * 0.85);
  });

  it("reports baseline entries that now pass", () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as {
      knownFailing: string[];
    };
    const stillFailing = new Set(failures.map((failure) => failure.route));
    const stale = baseline.knownFailing.filter((route) => sweptPaths.includes(route) && !stillFailing.has(route));

    // Reported rather than asserted, on purpose. Whether a baselined endpoint
    // fails can depend on the environment rather than the code: GET
    // /api/sessions reads the connect-pg-simple `session` table, which exists
    // once the real server has booted but not under the in-memory session store
    // these tests use. Failing the build on that difference would make the
    // suite environment-sensitive for no safety gain - the invariant that
    // actually protects a split is "no unexpected 5xx", asserted above.
    if (stale.length > 0) {
      console.warn(
        `[api-smoke-sweep] ${stale.length} baselined endpoint(s) now pass and can be removed ` +
          `from config/api-smoke-baseline.json:\n  ${stale.join("\n  ")}`
      );
    }

    expect(stale.every((route) => baseline.knownFailing.includes(route))).toBe(true);
  });
});
