/**
 * Response pins for the six route files whose bulk is a single handler.
 *
 * These are the last of the Phase 3 monoliths, and the route manifest cannot
 * carry them: it proves a route is still *registered* after a change, not that
 * the handler still computes the same figures. Reducing these files means
 * extracting logic from inside the handler, so the figures are exactly what is
 * at risk - and they are net profit, supplier statements and purchase orders.
 *
 * So each endpoint's response is hashed against a seeded fixture and pinned
 * here. Extract freely; if a number moves, this fails.
 *
 *   Regenerate (only after a *deliberate* behaviour change):
 *     UPDATE_REPORT_CHARACTERIZATION=1 npm run test:backend -- report-endpoint
 *
 * Volatile fields (ids, timestamps, generated filenames) are stripped before
 * hashing - see normalize() - because they differ per seed and would make the
 * pin useless rather than strict.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

/**
 * Two fixtures: the factory endpoints resolve a factory-type company and answer
 * 403 against an ERP one, so pinning them from a single seed would pin the
 * guard rather than the handler.
 */
const ERP_PREFIX = "chartest";
const FACTORY_PREFIX = "charfact";
const PIN_PATH = path.join(process.cwd(), "config/report-characterization.json");
const shouldUpdate = process.env.UPDATE_REPORT_CHARACTERIZATION === "1";
const REQUEST_TIMEOUT_MS = 30000;

/**
 * Every one of these handlers falls back to "today" for its as-of date, via
 * getClientDate(req) or a query default. Left alone the pins would only hold
 * within a single day and fail at the first midnight - which is exactly what
 * happened while building them. getClientDate reads this header first, so
 * sending it fixes the as-of date for the whole suite.
 */
const FIXED_CLIENT_DATE = "2030-12-31";

interface PinnedEndpoint {
  /** Route file this endpoint is the whole of, for traceability. */
  sourceModule: string;
  /** Which seeded company this endpoint needs to reach its handler. */
  fixture: "erp" | "factory";
  method: "GET" | "POST" | "PATCH";
  path: string;
  /** Query string appended verbatim; keeps the request deterministic. */
  query?: string;
  body?: Record<string, unknown>;
  /** Response is a file, not JSON: hash the bytes instead of the parsed body. */
  binary?: boolean;
  /**
   * This endpoint writes. It gets its own seed-and-release cycle so the rows it
   * creates cannot reach the read pins captured from the shared fixture, and so
   * re-running the suite starts from the same state every time. Without this an
   * offload posted during capture would shift the net-profit figures pinned
   * above, and the two pins would fight each other.
   */
  isolate?: boolean;
  /**
   * Rows the handler needs that seedTestData does not create, plus the path
   * substitutions they produce. Runs inside the endpoint's own fixture.
   */
  setup?: (ctx: TestContext, prefix: string) => Promise<Record<string, string>>;
  /** Removes anything `setup` created outside the company-scoped teardown. */
  teardown?: (ctx: TestContext, prefix: string) => Promise<void>;
}

/**
 * The `containers`, `purchase_orders` and `suppliers` tables are not company-
 * scoped in cleanupTestData — suppliers has no company column at all — so a PO
 * fixture has to clear up after itself. Both identifiers are UNIQUE, so the
 * delete also has to run *before* the insert or a re-run collides with its own
 * leftovers from a crashed one.
 */
async function clearPurchaseOrderFixture(prefix: string): Promise<void> {
  // po_line_items cascades from purchase_orders, so the PO delete covers it.
  await pool.query(`DELETE FROM purchase_orders WHERE po_number = $1`, [`${prefix}-PO-1`]);
  await pool.query(`DELETE FROM containers WHERE container_number = $1`, [`${prefix}-CONT-1`]);
  await pool.query(`DELETE FROM suppliers WHERE code = $1`, [`${prefix}-SUP-1`]);
}

/**
 * One entry per remaining single-handler route file. `path` may contain
 * `:companyId` / `:supplierId`, substituted from the seeded fixture.
 */
const ENDPOINTS: PinnedEndpoint[] = [
  {
    sourceModule: "server/routes/stats/statsNetProfitRoutes.ts",
    fixture: "erp",
    method: "GET",
    path: "/api/stats/net-profit",
    query: "startDate=2020-01-01&endDate=2030-12-31",
  },
  {
    sourceModule: "server/routes/netProfitExcelRoute.ts",
    fixture: "erp",
    method: "GET",
    path: "/api/reports/net-profit-excel",
    query: "startDate=2020-01-01&endDate=2030-12-31",
    binary: true,
  },
  {
    sourceModule: "server/routes/factory/employee-pos/employeeNetPositionRoutes.ts",
    fixture: "factory",
    method: "GET",
    path: "/api/factory/net-position",
    // Today's report. A future asOf is now refused (400), and a past one is a
    // known-at-cutoff snapshot; the fixture's rows are all dated by today.
  },
  {
    sourceModule: "server/routes/factory/suppliers/supplierStatementRoutes.ts",
    fixture: "factory",
    method: "GET",
    path: "/api/factory/suppliers/:supplierId/statement",
  },
  {
    // The 1,156-line handler in this file, and the one the god-file program
    // named as having no test referencing it at all. It recomputes a purchase
    // order's charge totals, so the figures are the whole point.
    sourceModule: "server/routes/containers/containerFreightWriteRoutes.ts",
    fixture: "erp",
    method: "PATCH",
    path: "/api/purchase-orders/:poId",
    isolate: true,
    body: {
      freight: "150.50",
      surcharge: "25.00",
      fumigation: "10.00",
      documentCharges: "5.00",
      discount: "2.50",
      otherCharges: "7.25",
    },
    setup: async (ctx, prefix) => {
      await clearPurchaseOrderFixture(prefix);

      const supplier = await pool.query(
        `INSERT INTO suppliers (code, legal_name, email) VALUES ($1, $2, $3) RETURNING id`,
        [`${prefix}-SUP-1`, `${prefix} Supplier`, `${prefix}@example.test`]
      );
      const container = await pool.query(
        `INSERT INTO containers (company_id, container_number, supplier_id, import_date, items_total)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [ctx.companyId, `${prefix}-CONT-1`, supplier.rows[0].id, "2030-01-15", "1000.00"]
      );
      const po = await pool.query(
        `INSERT INTO purchase_orders (company_id, po_number, container_id, supplier_id, currency, items_total)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ctx.companyId, `${prefix}-PO-1`, container.rows[0].id, supplier.rows[0].id, "USD", "1000.00"]
      );
      // One line item, so the recomputed grand total is items + charges rather
      // than charges against an empty order.
      await pool.query(
        `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [po.rows[0].id, ctx.stockItemIds[0], "Pinned line item", "100.000", "10.00", "1000.00"]
      );
      return { ":poId": String(po.rows[0].id) };
    },
    teardown: async (_ctx, prefix) => clearPurchaseOrderFixture(prefix),
  },
  {
    // The 972-line handler: landed-cost calculation for a container receipt.
    // It writes raw stock and posts journals, which is why it is isolated.
    sourceModule: "server/routes/factory/raw-stock/rawStockOffloadRoutes.ts",
    fixture: "factory",
    method: "POST",
    path: "/api/factory/raw-stock/offload",
    isolate: true,
    body: {
      receivedKg: "1000",
      costPerKg: "2.5",
      currencyCode: "USD",
      fxRateToUsd: "1",
      offloadDate: "2030-12-31",
    },
    setup: async (ctx, prefix) => {
      // factory_containers *is* company-scoped in cleanupTestData, so this
      // needs no teardown of its own.
      const container = await pool.query(
        `INSERT INTO factory_containers
           (company_id, container_number, declared_kg, rate_per_kg, currency_code, fx_rate_to_usd, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [ctx.companyId, `${prefix}-FC-1`, "1000.000", "2.500000", "USD", "1", "PENDING"]
      );
      return { ":containerId": String(container.rows[0].id) };
    },
  },
];

/**
 * The route files this suite exists to protect. Asserted against the pins, so
 * that "the six single-handler files are pinned" is a checked claim rather than
 * a sentence in a comment — it read "six" while covering four.
 */
const PHASE_3_MODULES = [
  "server/routes/stats/statsNetProfitRoutes.ts",
  "server/routes/netProfitExcelRoute.ts",
  "server/routes/factory/employee-pos/employeeNetPositionRoutes.ts",
  "server/routes/factory/suppliers/supplierStatementRoutes.ts",
  "server/routes/containers/containerFreightWriteRoutes.ts",
  "server/routes/factory/raw-stock/rawStockOffloadRoutes.ts",
];

interface PinFile {
  description: string;
  regenerate: string;
  pins: Record<string, { status: number; shape: string; hash: string }>;
}

/**
 * Strip anything that legitimately varies between seeds so the hash reflects
 * computed values only. Keys are matched by name at any depth.
 */
const VOLATILE_KEYS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "companyId",
  "supplierId",
  "customerId",
  "userId",
  "locationId",
  "stockItemId",
  "voucherId",
  "containerId",
  "generatedAt",
  "timestamp",
  "filename",
  // Set to now() when the offload posts, so it differs on every capture. Listed
  // rather than caught by a `/At$/` rule: the broad rule also drops stable
  // date fields from the other pins, and these hashes are the only thing
  // standing between an extraction and a silent change to a money figure —
  // strictness is worth more here than a rule that pre-empts the next one.
  "offloadedAt",
  // Factory Net Position's live report is dated "today" in the company's
  // timezone, so both change with the calendar day of the run.
  "asOf",
  "businessToday",
  // Phase 17 reports which cash/bank ledger accounts were FX-translated. The
  // values are raw ledger account ids from the seeded fixture, so they differ on
  // every capture and would make this pin unsettleable. The translation figures
  // beside it (currentCashBankTranslationDifference, unresolvedAccountCount)
  // stay hashed, so a change to the money still fails here.
  "currentTranslatedLedgerAccountIds",
]);

function isVolatileKey(key: string): boolean {
  return VOLATILE_KEYS.has(key);
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (isVolatileKey(key)) continue;
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** A stable description of the response's structure, independent of values. */
function shapeOf(value: unknown, depth = 0): string {
  if (depth > 4) return "…";
  if (Array.isArray(value)) return value.length ? `[${shapeOf(value[0], depth + 1)}]` : "[]";
  if (value === null) return "null";
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.join(",")}}`;
  }
  return typeof value;
}

/** Every sheet's cell values, in order - the workbook's figures without its container. */
async function workbookValues(buffer: Buffer): Promise<unknown> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  return workbook.worksheets.map((sheet) => {
    const rows: unknown[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row) => {
      rows.push(
        (row.values as unknown[]).map((cell) =>
          cell && typeof cell === "object" && "result" in (cell as any) ? (cell as any).result : cell
        )
      );
    });
    return { name: sheet.name, rows };
  });
}

const hash = (value: unknown) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");

function loadPins(): PinFile {
  if (!fs.existsSync(PIN_PATH)) {
    return {
      description: "",
      regenerate: "",
      pins: {},
    };
  }
  return JSON.parse(fs.readFileSync(PIN_PATH, "utf8")) as PinFile;
}

const observed: PinFile["pins"] = {};

/** Seed one fixture, walk the endpoints that need it, then release it. */
async function captureWith(prefix: string, fixture: "erp" | "factory"): Promise<void> {
  const ctx: TestContext = await seedTestData(prefix);
  try {
    const agent = request.agent(ctx.app);
    const login = await agent.post("/api/auth/login").send({
      username: `${prefix}_testuser`,
      password: "testpassword123",
    });
    if (login.status !== 200) throw new Error(`Login failed for ${prefix}: ${login.status}`);
    await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

    // The shared fixture seeds no factory supplier, so the statement endpoint
    // would 404 for any id and the pin would capture the miss rather than the
    // report. Create one and pin the statement it actually produces.
    let supplierId = 0;
    if (fixture === "factory") {
      const created = await agent
        .post("/api/factory/suppliers")
        .send({ name: `${prefix} supplier`, currencyCode: "USD" });
      supplierId = (created.body as { id?: number })?.id ?? 0;
      if (!supplierId) throw new Error(`Could not seed a factory supplier: ${created.status}`);
    }

    for (const endpoint of ENDPOINTS.filter((e) => e.fixture === fixture && !e.isolate)) {
      const resolved = endpoint.path.replace(":supplierId", String(supplierId));
      const url = endpoint.query ? `${resolved}?${endpoint.query}` : resolved;

      let call = agent[endpoint.method === "GET" ? "get" : "post"](url).set("x-client-date", FIXED_CLIENT_DATE);
      if (endpoint.binary)
        call = call.buffer(true).parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      const response = await call
        .send(endpoint.body ?? undefined)
        .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });

      // An xlsx buffer is not byte-stable - the zip container records a
      // creation time - so hashing the bytes would fail on every run. Read the
      // workbook and hash the cell values, which is the part worth pinning.
      const isBuffer = endpoint.binary && Buffer.isBuffer(response.body);
      observed[`${endpoint.method} ${endpoint.path}`] = {
        status: response.status,
        shape: isBuffer ? `workbook:${response.type}` : shapeOf(response.body),
        hash: isBuffer ? hash(await workbookValues(response.body as Buffer)) : hash(response.body),
      };
    }
  } finally {
    // Only one fixture company may exist at a time - the suite pins
    // system_settings.parentCompanyId - so release before seeding the next.
    await cleanupTestData(prefix);
  }
}

/**
 * One write endpoint, in a fixture of its own.
 *
 * A mutating handler cannot share the read fixture: the rows it writes would
 * change what the net-position and statement pins compute, so the two would
 * drift against each other for reasons unrelated to any code change. Seeding
 * per endpoint costs a few seconds and makes each pin independent of the order
 * the suite happens to run in.
 */
async function captureIsolated(endpoint: PinnedEndpoint, prefix: string): Promise<void> {
  const ctx: TestContext = await seedTestData(prefix);
  try {
    const agent = request.agent(ctx.app);
    const login = await agent.post("/api/auth/login").send({
      username: `${prefix}_testuser`,
      password: "testpassword123",
    });
    if (login.status !== 200) throw new Error(`Login failed for ${prefix}: ${login.status}`);
    await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

    const substitutions = endpoint.setup ? await endpoint.setup(ctx, prefix) : {};
    let resolved = endpoint.path;
    for (const [token, value] of Object.entries(substitutions)) {
      resolved = resolved.replace(token, value);
    }
    const url = endpoint.query ? `${resolved}?${endpoint.query}` : resolved;

    const send = { get: "get", post: "post", patch: "patch" } as const;
    const verb = send[endpoint.method.toLowerCase() as keyof typeof send];

    // The body carries the ids the handler needs, which only exist once setup
    // has run — so merge the substitutions in rather than hard-coding them.
    const body = { ...(endpoint.body ?? {}) };
    if (substitutions[":containerId"]) body.containerId = Number(substitutions[":containerId"]);

    const response = await agent[verb](url)
      .set("x-client-date", FIXED_CLIENT_DATE)
      .send(body)
      .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });

    observed[`${endpoint.method} ${endpoint.path}`] = {
      status: response.status,
      shape: shapeOf(response.body),
      hash: hash(response.body),
    };

    if (endpoint.teardown) await endpoint.teardown(ctx, prefix);
  } finally {
    await cleanupTestData(prefix);
  }
}

beforeAll(async () => {
  await captureWith(ERP_PREFIX, "erp");
  await captureWith(FACTORY_PREFIX, "factory");

  for (const endpoint of ENDPOINTS.filter((e) => e.isolate)) {
    await captureIsolated(endpoint, endpoint.fixture === "factory" ? FACTORY_PREFIX : ERP_PREFIX);
  }

  if (shouldUpdate) {
    const file: PinFile = {
      description:
        "Response pins for the single-handler route files remaining in Phase 3. The " +
        "route manifest proves a route is still registered; these prove the handler " +
        "still computes the same figures. Volatile fields (ids, timestamps) are " +
        "stripped before hashing.",
      regenerate: "UPDATE_REPORT_CHARACTERIZATION=1 npm run test:backend -- report-endpoint",
      pins: observed,
    };
    fs.writeFileSync(PIN_PATH, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
}, 300000);

afterAll(() => {
  closeTestServer();
});

describe("single-handler report endpoints keep their computed output", () => {
  const pinned = loadPins();

  it("has a pin recorded for every endpoint under extraction", () => {
    const missing = ENDPOINTS.map((e) => `${e.method} ${e.path}`).filter((key) => !pinned.pins[key]);
    expect(missing, `No pin for:\n${missing.join("\n")}\nRegenerate with ${pinned.regenerate}`).toEqual([]);
  });

  it("covers every single-handler route file the split program is blocked on", () => {
    const covered = new Set(ENDPOINTS.map((e) => e.sourceModule));
    const uncovered = PHASE_3_MODULES.filter((module) => !covered.has(module));

    // Without this, the suite can quietly protect fewer files than its own
    // documentation claims — which is exactly what had happened.
    expect(uncovered, `Phase 3 route files with no response pin:\n${uncovered.join("\n")}`).toEqual([]);
  });

  it("never pins a server error as if it were the expected output", () => {
    const errored = Object.entries(observed)
      .filter(([, result]) => result.status >= 500)
      .map(([key, result]) => `${key} → ${result.status}`);

    // A 500 hashes as stably as a real answer, so without this a broken
    // endpoint would be frozen in as "correct" and the pin would then defend
    // the breakage.
    expect(errored, `Endpoints returned a server error while capturing:\n${errored.join("\n")}`).toEqual([]);
  });

  it.each(ENDPOINTS)("$method $path returns the pinned status and shape", (endpoint) => {
    const key = `${endpoint.method} ${endpoint.path}`;
    const expected = pinned.pins[key];
    if (!expected) return; // reported by the test above

    expect(observed[key].status, `${key} status changed`).toBe(expected.status);
    expect(observed[key].shape, `${key} response shape changed`).toBe(expected.shape);
  });

  it.each(ENDPOINTS)("$method $path returns the pinned figures", (endpoint) => {
    const key = `${endpoint.method} ${endpoint.path}`;
    const expected = pinned.pins[key];
    if (!expected) return;

    expect(
      observed[key].hash,
      `${key} returned different values for the same fixture. If the change was ` +
        `deliberate, regenerate with: ${pinned.regenerate}`
    ).toBe(expected.hash);
  });
});
