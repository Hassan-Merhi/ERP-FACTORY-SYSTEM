import { AsyncLocalStorage } from "node:async_hooks";
import { vi } from "vitest";

const MISSING_ID = 2_147_481_900;
const moduleLoaders = import.meta.glob("../../server/routes/**/*.ts");

const EXCLUDED_MODULES =
  /(?:\.test\.ts$|\/__tests__\/|trackTrace|whatsapp|screenFeed|remoteControl|webhook|openai|gemini|backup|deployment|serverControl)/i;
const EXCLUDED_ROUTES =
  /(?:whatsapp|webhook|screen-feed|remote-control|\/email(?:\/|$)|\/send(?:\/|$)|\/backup(?:\/|$))/i;

type Handler = (req: Record<string, any>, res: Record<string, any>, next: (error?: unknown) => void) => unknown;

type Registration = {
  method: string;
  routePath: string;
  handlers: Handler[];
  modulePath: string;
};

type CompanyMode = "erp" | "factory" | "factory_v2" | "retail" | "supplier_partner" | "properties";

type HarnessState = {
  companyType: CompanyMode;
  sequence: number;
};

type ProbeContext = { queries: number };

// Several routers resolve a free code or number by querying in a loop until the
// lookup comes back empty ("does PH33-1 exist? then PH33-2..."). The database
// double answered every one of those with a row, so the loop never ended — and
// because each iteration only awaited an already-resolved promise, it starved
// the macrotask queue, so the probe's own budget timer could never fire. A
// whole shard then sat at 100% CPU inside one handler until the 900s process
// budget killed it. Giving each probe a query budget makes those lookups run
// out of rows the way an empty table would, which ends the loop and lets the
// sweep move on. Real handlers issue a few dozen queries at most, so the budget
// only ever bites on a runaway loop.
const PROBE_QUERY_BUDGET = 150;
const probeContext = new AsyncLocalStorage<ProbeContext>();

function probeRowsExhausted(): boolean {
  const context = probeContext.getStore();
  if (!context) return false;
  context.queries += 1;
  return context.queries > PROBE_QUERY_BUDGET;
}

function stableBucket(value: string, buckets: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % buckets;
}

function modeFor(route: Registration): CompanyMode {
  const value = `${route.modulePath} ${route.routePath}`.toLowerCase();
  if (value.includes("retail")) return "retail";
  if (value.includes("rental") || value.includes("properties")) return "properties";
  if (
    value.includes("/sp/") ||
    value.includes("spmigration") ||
    value.includes("sp-migration") ||
    value.includes("goldencoast") ||
    value.includes("supplier-partner") ||
    value.includes("supplier_partner")
  ) {
    return "supplier_partner";
  }
  if (value.includes("factory_v2") || value.includes("factory-v2")) return "factory_v2";
  if (value.includes("/factory/") || route.routePath.startsWith("/api/factory/")) return "factory";
  return "erp";
}

function genericRow(state: HarnessState): Record<string, any> {
  const base: Record<string, any> = {
    id: 1,
    companyId: 1,
    company_id: 1,
    parentCompanyId: null,
    parent_company_id: null,
    companyType: state.companyType,
    company_type: state.companyType,
    userId: "phase33-user",
    user_id: "phase33-user",
    username: "phase33",
    role: "Admin",
    status: "active",
    active: true,
    enabled: true,
    isActive: true,
    is_active: true,
    approved: true,
    code: "PH33",
    name: "Phase 33",
    legalName: "Phase 33",
    legal_name: "Phase 33",
    currency: "USD",
    baseCurrency: "USD",
    base_currency: "USD",
    amount: "1",
    balance: "1",
    quantity: "1",
    qty: "1",
    cost: "1",
    price: "1",
    rate: "1",
    total: "1",
    count: 0,
    date: "2026-09-15",
    createdAt: new Date("2026-09-15T00:00:00Z"),
    updatedAt: new Date("2026-09-15T00:00:00Z"),
    metadata: {},
    settings: {},
    permissions: [],
  };

  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === "symbol") return Reflect.get(target, prop);
      if (prop in target) return target[prop];
      const key = String(prop).toLowerCase();
      if (key === "companytype" || key === "company_type") return state.companyType;
      if (key === "count" || key.endsWith("_count") || key.endsWith("count")) return 0;
      if (key.endsWith("id") || key.endsWith("_id")) return 1;
      if (key.startsWith("is") || key.startsWith("can") || key.includes("active") || key.includes("enabled"))
        return true;
      if (key.includes("date") || key.includes("time") || key.endsWith("at")) return new Date("2026-09-15T00:00:00Z");
      if (
        key.includes("amount") ||
        key.includes("balance") ||
        key.includes("quantity") ||
        key.includes("weight") ||
        key.includes("cost") ||
        key.includes("price") ||
        key.includes("rate") ||
        key.includes("total") ||
        key.includes("debit") ||
        key.includes("credit")
      ) {
        return "1";
      }
      if (key.includes("currency")) return "USD";
      if (key.includes("status")) return "active";
      if (key.includes("role")) return "Admin";
      if (key.includes("items") || key.includes("lines") || key.includes("entries") || key.includes("rows")) return [];
      if (key.includes("metadata") || key.includes("settings") || key.includes("config")) return {};
      return "phase33";
    },
  });
}

function queryBuilder(state: HarnessState, rowsFactory: () => any[] = () => [genericRow(state)]): any {
  let resultFactory = rowsFactory;
  let proxy: any;
  proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(resultFactory()).then(resolve, reject);
        }
        if (prop === "catch")
          return (reject: (reason: unknown) => unknown) => Promise.resolve(resultFactory()).catch(reject);
        if (prop === "finally") return (callback: () => void) => Promise.resolve(resultFactory()).finally(callback);
        if (prop === "execute") return async () => resultFactory();
        if (prop === "returning") return () => queryBuilder(state, () => [genericRow(state)]);
        if (prop === "get") return async () => (probeRowsExhausted() ? undefined : genericRow(state));
        if (prop === "all") return async () => resultFactory();
        return (..._args: unknown[]) => proxy;
      },
    }
  );
  return proxy;
}

function makeDatabase(state: HarnessState) {
  let fakeDb: any;
  const rowResult = () => (probeRowsExhausted() ? [] : [genericRow(state)]);
  fakeDb = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "select") return (..._args: unknown[]) => queryBuilder(state, rowResult);
        if (prop === "insert") return (..._args: unknown[]) => queryBuilder(state, rowResult);
        if (prop === "update") return (..._args: unknown[]) => queryBuilder(state, rowResult);
        if (prop === "delete") return (..._args: unknown[]) => queryBuilder(state, () => []);
        if (prop === "execute")
          return async (..._args: unknown[]) => {
            const rows = rowResult();
            return { rows, rowCount: rows.length };
          };
        if (prop === "transaction") {
          return async (callback: (tx: any) => unknown) => callback(fakeDb);
        }
        if (prop === "query") {
          return new Proxy(
            {},
            {
              get: () => async () => rowResult(),
            }
          );
        }
        return (..._args: unknown[]) => queryBuilder(state, rowResult);
      },
    }
  );

  const client = {
    query: async (..._args: unknown[]) => {
      const rows = rowResult();
      return { rows, rowCount: rows.length };
    },
    release: () => undefined,
  };
  const fakePool: any = {
    query: client.query,
    connect: async () => client,
    on: () => fakePool,
    end: async () => undefined,
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };

  return { fakeDb, fakePool };
}

function fakeApp(modulePath: string, registrations: Registration[]): Record<string, unknown> {
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const method = String(prop).toLowerCase();
        if (methods.has(method)) {
          return (routePath: unknown, ...handlers: unknown[]) => {
            if (typeof routePath !== "string") return undefined;
            registrations.push({
              method: method.toUpperCase(),
              routePath,
              handlers: handlers.flat().filter((value): value is Handler => typeof value === "function"),
              modulePath,
            });
            return undefined;
          };
        }
        if (["use", "all", "options", "head", "set", "disable", "enable"].includes(method)) return () => undefined;
        return undefined;
      },
    }
  );
}

function responseDouble(): Record<string, any> {
  const res: Record<string, any> = { statusCode: 200, headersSent: false, locals: {}, body: undefined };
  const chain = () => res;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (value: unknown) => {
    res.body = value;
    res.headersSent = true;
    return res;
  };
  res.send = res.json;
  res.end = res.json;
  res.sendStatus = (code: number) => {
    res.statusCode = code;
    res.headersSent = true;
    return res;
  };
  res.write = () => true;
  res.set = chain;
  res.header = chain;
  res.setHeader = chain;
  res.type = chain;
  res.attachment = chain;
  res.cookie = chain;
  res.clearCookie = chain;
  res.redirect = chain;
  res.render = (_view: unknown, data?: unknown) => res.json(data ?? {});
  res.sendFile = (_file: unknown, options?: unknown, callback?: unknown) => {
    const cb = typeof options === "function" ? options : callback;
    if (typeof cb === "function") cb();
    res.headersSent = true;
    return res;
  };
  res.download = (_file: unknown, _name?: unknown, callback?: unknown) => {
    if (typeof callback === "function") callback();
    res.headersSent = true;
    return res;
  };
  return res;
}

function megaBody(sequence: number): Record<string, any> {
  const code = `PH33-${sequence}`;
  const item = {
    id: 1,
    stockItemId: 1,
    itemId: 1,
    productId: 1,
    variantId: 1,
    locationId: 1,
    quantity: 1,
    qty: 1,
    rate: 1,
    cost: 1,
    price: 2,
    unitPrice: 2,
    sellingPrice: 2,
    amount: 1,
    size: "M",
    barcode: `${code}-BC`,
    stocks: [{ locationId: 1, quantity: 1 }],
  };
  return {
    id: 1,
    companyId: 1,
    sourceCompanyId: 1,
    targetCompanyId: 1,
    parentCompanyId: 1,
    locationId: 1,
    fromLocationId: 1,
    toLocationId: 1,
    sourceLocationId: 1,
    destinationLocationId: 1,
    stockItemId: 1,
    itemId: 1,
    productId: 1,
    variantId: 1,
    stockItemIds: [1],
    stockGroupId: 1,
    groupId: 1,
    accountId: 1,
    salesAccountId: 1,
    cashAccountId: 1,
    debitAccountId: 1,
    creditAccountId: 1,
    supplierId: 1,
    customerId: 1,
    containerId: 1,
    voucherId: 1,
    orderId: 1,
    proformaId: 1,
    workerId: 1,
    employeeId: 1,
    userId: "phase33-user",
    quantity: 1,
    qty: 1,
    amount: 1,
    rate: 1,
    cost: 1,
    price: 2,
    unitPrice: 2,
    sellingPrice: 2,
    currency: "USD",
    exchangeRate: 1,
    date: "2026-09-15",
    transactionDate: "2026-09-15",
    effectiveDate: "2026-09-15",
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    fromDate: "2026-09-01",
    toDate: "2026-09-30",
    dueDate: "2026-09-30",
    status: "active",
    type: "standard",
    voucherType: "Journal",
    transactionType: "sale",
    paymentMethod: "cash",
    movementType: "adjustment",
    name: `Phase 33 ${code}`,
    legalName: `Phase 33 ${code}`,
    code,
    reference: code,
    description: "Phase 33 synthetic route coverage probe",
    notes: "Phase 33 synthetic route coverage probe",
    narration: "Phase 33 synthetic route coverage probe",
    reason: "Phase 33 synthetic route coverage probe",
    active: true,
    isActive: true,
    approved: true,
    confirmed: true,
    force: false,
    dryRun: true,
    preview: true,
    category: "General",
    brandName: "Phase 33 Brand",
    imageUrls: [],
    size: "M",
    barcode: `${code}-BC`,
    items: [item],
    lines: [item],
    variants: [{ ...item, id: undefined }],
    entries: [
      { accountId: 1, debit: 1, credit: 0, description: code },
      { accountId: 1, debit: 0, credit: 1, description: code },
    ],
    permissions: [],
    settings: {},
  };
}

function requestDouble(route: Registration, state: HarnessState, variant: number): Record<string, any> {
  const params: Record<string, string> = {};
  for (const match of route.routePath.matchAll(/:([A-Za-z0-9_]+)/g)) params[match[1]] = "1";

  const body = megaBody(state.sequence++);
  const jsonPayload = Buffer.from(JSON.stringify({ sourceCompanyId: MISSING_ID, tables: {} }), "utf8");
  const file = {
    fieldname: "file",
    originalname: "phase33.json",
    encoding: "7bit",
    mimetype: "application/json",
    size: jsonPayload.length,
    buffer: jsonPayload,
  };
  const session = {
    userId: "phase33-user",
    currentCompanyId: 1,
    selectedCompanyId: 1,
    companyId: 1,
    role: "Admin",
    authorizedCompanyIds: [1],
    passport: { user: "phase33-user" },
    save: (callback?: () => void) => callback?.(),
    touch: () => undefined,
    regenerate: (callback?: (error?: unknown) => void) => callback?.(),
    destroy: (callback?: (error?: unknown) => void) => callback?.(),
  };

  const req: Record<string, any> = {
    method: route.method,
    path: route.routePath,
    url: route.routePath,
    originalUrl: route.routePath,
    baseUrl: "",
    params,
    query: {
      ...params,
      id: "1",
      page: "1",
      limit: "25",
      offset: "0",
      companyId: "1",
      locationId: "1",
      stockItemId: "1",
      accountId: "1",
      supplierId: "1",
      customerId: "1",
      containerId: "1",
      voucherId: "1",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
      year: "2026",
      month: "9",
      status: "all",
      type: "all",
      currency: "USD",
      search: "phase33",
      q: "phase33",
      dryRun: "true",
      preview: "true",
    },
    body,
    session,
    user: {
      id: "phase33-user",
      userId: "phase33-user",
      username: "phase33",
      role: "Admin",
      companyId: 1,
      currentCompanyId: 1,
      selectedCompanyId: 1,
      authorizedCompanyIds: [1],
      permissions: [],
    },
    headers: { "content-type": "application/json", host: "localhost" },
    cookies: {},
    signedCookies: {},
    ip: "127.0.0.1",
    ips: ["127.0.0.1"],
    hostname: "localhost",
    protocol: "http",
    secure: false,
    file,
    files: [file],
    app: { get: () => undefined },
    get: (name: string) => (name.toLowerCase() === "host" ? "localhost" : undefined),
    header: () => undefined,
    accepts: () => true,
    is: () => true,
    isAuthenticated: () => true,
    logout: (callback?: (error?: unknown) => void) => callback?.(),
    logIn: (_user: unknown, callback?: (error?: unknown) => void) => callback?.(),
    login: (_user: unknown, callback?: (error?: unknown) => void) => callback?.(),
  };

  if (variant === 1) {
    req.query = { ...req.query, page: "2", limit: "1", search: "missing", status: "inactive", currency: "CDF" };
    req.body = { ...body, active: false, approved: false, currency: "CDF", exchangeRate: 2800, quantity: 2, amount: 4 };
  } else if (variant === 2) {
    for (const key of Object.keys(req.params)) req.params[key] = String(MISSING_ID);
    req.query = {
      ...req.query,
      id: String(MISSING_ID),
      stockItemId: String(MISSING_ID),
      accountId: String(MISSING_ID),
    };
    req.body = { ...body, id: MISSING_ID, stockItemId: MISSING_ID, accountId: MISSING_ID };
  } else if (variant === 3) {
    for (const key of Object.keys(req.params)) req.params[key] = "not-a-number";
    req.query = { id: "not-a-number", page: "0", limit: "-1", startDate: "bad-date", endDate: "bad-date" };
    req.body = { id: "not-a-number", companyId: "bad", quantity: -1, amount: -1, exchangeRate: 0, date: "bad-date" };
  } else if (variant === 4) {
    // Express always installs `req.session` and Passport always installs
    // `req.user`, so an unauthenticated request carries empty objects rather
    // than missing ones. Deleting them instead made terminal handlers — which
    // real routing would never reach unauthenticated, and which several routers
    // register as floating `void handler(...)` wrappers this harness cannot
    // catch — reject with `Cannot read properties of undefined`, surfacing as
    // Vitest unhandled rejections that failed otherwise green shards.
    req.session = {};
    req.user = {};
    req.isAuthenticated = () => false;
  } else if (variant === 5) {
    req.session.role = "Staff";
    req.user.role = "Staff";
    req.user.permissions = [];
  }

  return req;
}

async function invokeWithBudget(handler: Handler, req: Record<string, any>, res: Record<string, any>, budgetMs = 15) {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    probeContext.run({ queries: 0 }, () =>
      Promise.resolve()
        .then(() => handler(req, res, () => undefined))
        .catch(() => undefined)
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

// Probe budgets are wall-clock deadlines, not CPU work: almost every probe waits
// out its full budget because the handler parks on a mocked awaitable. Sweeping
// ~2.6k registrations x 6 variants x their handler chains one at a time
// therefore spends ~6 minutes per bucket sleeping on timers while the process
// sits near-idle, which is what pushed whole shards past their budget. Probing
// several routes at once overlaps those deadlines instead of shortening them,
// so every registration, variant and handler still runs with at least as much
// wall-clock budget as before.
const PROBE_CONCURRENCY = Math.max(1, Number(process.env.PHASE33_SYNTHETIC_PROBE_CONCURRENCY ?? 16));
const PRIMARY_VARIANT_BUDGET_MS = 40;
const SECONDARY_VARIANT_BUDGET_MS = 20;

async function probeRoute(route: Registration, state: HarnessState): Promise<number> {
  let invoked = 0;
  for (let variant = 0; variant < 6; variant += 1) {
    const req = requestDouble(route, state, variant);
    for (const handler of route.handlers) {
      await invokeWithBudget(
        handler,
        req,
        responseDouble(),
        variant < 2 ? PRIMARY_VARIANT_BUDGET_MS : SECONDARY_VARIANT_BUDGET_MS
      );
      invoked += 1;
    }
  }
  return invoked;
}

// `state.companyType` is read lazily by the shared database double while a
// handler runs, so routes may only be overlapped with other routes that resolve
// to the same company mode. Grouping by mode keeps every probe seeing exactly
// the company shape the serial sweep gave it.
async function probeRouteGroup(routes: Registration[], state: HarnessState): Promise<number> {
  let cursor = 0;
  let invoked = 0;
  const workerCount = Math.min(PROBE_CONCURRENCY, routes.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < routes.length) {
        const route = routes[cursor];
        cursor += 1;
        invoked += await probeRoute(route, state);
      }
    })
  );
  return invoked;
}

export async function runSyntheticRouteBucket(
  bucket: number,
  bucketCount: number
): Promise<{
  importedModules: number;
  registerFunctions: number;
  registrations: number;
  invoked: number;
}> {
  const state: HarnessState = { companyType: "erp", sequence: bucket * 100_000 };
  const { fakeDb, fakePool } = makeDatabase(state);

  vi.doMock("../../server/db", () => ({
    db: fakeDb,
    pool: fakePool,
    logPoolStats: () => undefined,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: [], results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    )
  );

  const registrations: Registration[] = [];
  let importedModules = 0;
  let registerFunctions = 0;

  try {
    // Every bucket imports and registers every route module, then probes only
    // the routes that hash into its own slice. Bucketing by module path instead
    // put the two aggregators that re-register the whole application —
    // applicationRoutes.ts (1259 registrations) and factoryRoutes.ts (509) —
    // in one bucket, so a single shard probed 2627 registrations while the
    // lightest probed 378 and the heavy shards ran out of budget. Registering
    // everything costs ~20s per bucket and lets the probe work split evenly
    // (217-255 routes each) without dropping a single route from the sweep.
    const entries = Object.entries(moduleLoaders)
      .filter(([modulePath]) => !EXCLUDED_MODULES.test(modulePath))
      .sort(([left], [right]) => left.localeCompare(right));

    for (const [modulePath, loader] of entries) {
      try {
        const mod = (await loader()) as Record<string, unknown>;
        importedModules += 1;
        for (const [name, value] of Object.entries(mod)) {
          if (typeof value !== "function" || !/^register/i.test(name)) continue;
          registerFunctions += 1;
          try {
            await Promise.resolve((value as (app: unknown) => unknown)(fakeApp(modulePath, registrations)));
          } catch {
            // Keep exercising independent registrars if one needs extra dependencies.
          }
        }
      } catch {
        // Keep the sweep resilient to route modules with environment-only imports.
      }
    }

    // An aggregator and the module that owns a route register the same route
    // with freshly built closures, so function identity cannot tell the two
    // apart. Method, path and the handler chain's function names do: the
    // duplicate probes they collapse execute identical source, while a
    // genuinely different chain on the same path keeps its own probe. That
    // takes the sweep from 6478 registrations to 1874 distinct routes.
    const seen = new Set<string>();
    const routesByMode = new Map<CompanyMode, Registration[]>();
    let probed = 0;
    for (const route of registrations) {
      if (route.handlers.length === 0 || EXCLUDED_ROUTES.test(route.routePath)) continue;
      const chain = route.handlers.map((handler) => handler.name || "anonymous").join(">");
      const probeKey = `${route.method} ${route.routePath} ${chain}`;
      if (seen.has(probeKey)) continue;
      seen.add(probeKey);
      if (stableBucket(`${route.method} ${route.routePath}`, bucketCount) !== bucket) continue;
      probed += 1;
      const mode = modeFor(route);
      const group = routesByMode.get(mode);
      if (group) group.push(route);
      else routesByMode.set(mode, [route]);
    }

    let invoked = 0;
    for (const [mode, routes] of routesByMode) {
      state.companyType = mode;
      invoked += await probeRouteGroup(routes, state);
    }

    return { importedModules, registerFunctions, registrations: probed, invoked };
  } finally {
    vi.unstubAllGlobals();
    vi.doUnmock("../../server/db");
    vi.resetModules();
  }
}
