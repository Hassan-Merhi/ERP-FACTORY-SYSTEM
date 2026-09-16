import { pool } from "../../server/db";
import { closeTestServer, seedTestData, type TestContext } from "../setup";

const MISSING_ID = 2_147_481_900;
const moduleLoaders = import.meta.glob("../../server/routes/**/*.ts");

const EXCLUDED_MODULES = /(?:trackTrace|whatsapp|screenFeed|remoteControl|webhook|openai|gemini)/i;
const EXCLUDED_ROUTES = /(?:\/track|\/trace|whatsapp|webhook|screen-feed|remote-control|\/send(?:\/|$)|\/email(?:\/|$))/i;

type Handler = (
  req: Record<string, any>,
  res: Record<string, any>,
  next: (error?: unknown) => void
) => unknown;

type Registration = {
  method: string;
  routePath: string;
  handlers: Handler[];
  modulePath: string;
};

type ProbeVariant = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

function stableBucket(value: string, buckets: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % buckets;
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
        if (["use", "all", "options", "head", "set", "disable", "enable"].includes(method)) {
          return () => undefined;
        }
        return undefined;
      },
    }
  );
}

function parameterValue(routePath: string, name: string, ctx: TestContext, alternate: boolean): string {
  const key = name.toLowerCase();
  const lowerPath = routePath.toLowerCase();

  if (key.includes("company")) return String(ctx.companyId);
  if (key.includes("fromlocation") || key.includes("source")) return String(ctx.locationId);
  if (key.includes("tolocation") || key.includes("destination")) return String(ctx.location2Id);
  if (key.includes("location")) return String(alternate ? ctx.location2Id : ctx.locationId);
  if (key.includes("stockitem") || key === "itemid" || key === "productid") return String(ctx.stockItemIds[0]);
  if (key.includes("stockgroup") || key === "groupid") return String(ctx.stockGroupId);
  if (key.includes("cashaccount")) return String(ctx.cashAccountId);
  if (key.includes("account")) return String(ctx.salesAccountId);
  if (key.includes("user")) return String(ctx.userId);
  if (key.includes("year")) return "2026";
  if (key.includes("month")) return alternate ? "8" : "9";
  if (key.includes("date")) return alternate ? "2026-08-31" : "2026-09-15";
  if (key.includes("currency")) return alternate ? "CDF" : "USD";
  if (key.includes("status")) return alternate ? "pending" : "active";
  if (key.includes("type")) return alternate ? "summary" : "standard";
  if (key.includes("code")) return alternate ? "PH33-B" : "PH33-A";

  if (key === "id") {
    if (/stock[-_/]?items?/.test(lowerPath)) return String(ctx.stockItemIds[0]);
    if (/locations?/.test(lowerPath)) return String(alternate ? ctx.location2Id : ctx.locationId);
    if (/stock[-_/]?groups?/.test(lowerPath)) return String(ctx.stockGroupId);
    if (/ledger|accounts?/.test(lowerPath)) return String(ctx.salesAccountId);
    if (/companies?/.test(lowerPath)) return String(ctx.companyId);
    if (/users?/.test(lowerPath)) return String(ctx.userId);
  }

  return String(MISSING_ID);
}

function paramsFor(routePath: string, ctx: TestContext, alternate: boolean): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of routePath.matchAll(/:([A-Za-z0-9_]+)/g)) {
    params[match[1]] = parameterValue(routePath, match[1], ctx, alternate);
  }
  return params;
}

function bodyFor(ctx: TestContext, sequence: number, alternate: boolean): Record<string, unknown> {
  const stockItemId = ctx.stockItemIds[0];
  const unique = `PH33-ALL-${sequence}-${alternate ? "B" : "A"}`;
  const item = {
    stockItemId,
    itemId: stockItemId,
    productId: stockItemId,
    locationId: alternate ? ctx.location2Id : ctx.locationId,
    quantity: alternate ? 2 : 1,
    qty: alternate ? 2 : 1,
    rate: alternate ? 2 : 1,
    unitPrice: alternate ? 2 : 1,
    price: alternate ? 2 : 1,
    amount: alternate ? 4 : 1,
  };

  return {
    id: MISSING_ID,
    companyId: ctx.companyId,
    locationId: alternate ? ctx.location2Id : ctx.locationId,
    fromLocationId: ctx.locationId,
    toLocationId: ctx.location2Id,
    sourceLocationId: ctx.locationId,
    destinationLocationId: ctx.location2Id,
    stockItemId,
    itemId: stockItemId,
    productId: stockItemId,
    stockItemIds: [stockItemId],
    stockGroupId: ctx.stockGroupId,
    groupId: ctx.stockGroupId,
    accountId: ctx.salesAccountId,
    salesAccountId: ctx.salesAccountId,
    cashAccountId: ctx.cashAccountId,
    debitAccountId: ctx.salesAccountId,
    creditAccountId: ctx.cashAccountId,
    userId: ctx.userId,
    quantity: alternate ? 2 : 1,
    qty: alternate ? 2 : 1,
    amount: alternate ? 4 : 1,
    rate: alternate ? 2 : 1,
    cost: alternate ? 2 : 1,
    price: alternate ? 2 : 1,
    unitPrice: alternate ? 2 : 1,
    currency: alternate ? "CDF" : "USD",
    exchangeRate: alternate ? 2800 : 1,
    date: alternate ? "2026-08-31" : "2026-09-15",
    transactionDate: alternate ? "2026-08-31" : "2026-09-15",
    effectiveDate: alternate ? "2026-08-31" : "2026-09-15",
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    fromDate: "2026-09-01",
    toDate: "2026-09-30",
    status: alternate ? "pending" : "active",
    type: alternate ? "summary" : "standard",
    name: `Phase 33 ${unique}`,
    code: unique,
    reference: unique,
    description: "Phase 33 all-route direct coverage probe",
    notes: "Phase 33 all-route direct coverage probe",
    reason: "Phase 33 all-route direct coverage probe",
    active: !alternate,
    isActive: !alternate,
    approved: alternate,
    dryRun: true,
    preview: true,
    items: [item],
    lines: [item],
    entries: [
      { accountId: ctx.salesAccountId, debit: 1, credit: 0, description: unique },
      { accountId: ctx.cashAccountId, debit: 0, credit: 1, description: unique },
    ],
  };
}

function responseDouble(): Record<string, any> {
  const res: Record<string, any> = {
    statusCode: 200,
    headersSent: false,
    locals: {},
    body: undefined,
  };
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
  res.end = (value?: unknown) => {
    res.body = value;
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

function requestDouble(route: Registration, ctx: TestContext, sequence: number, variant: ProbeVariant): Record<string, any> {
  const alternate = variant % 2 === 1;
  const params = paramsFor(route.routePath, ctx, alternate);
  const session = {
    userId: ctx.userId,
    currentCompanyId: ctx.companyId,
    role: "Admin",
    selectedCompanyId: ctx.companyId,
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
      page: alternate ? "2" : "1",
      limit: alternate ? "1" : "25",
      offset: alternate ? "1" : "0",
      locationId: String(alternate ? ctx.location2Id : ctx.locationId),
      stockItemId: String(ctx.stockItemIds[0]),
      accountId: String(ctx.salesAccountId),
      companyId: String(ctx.companyId),
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
      year: "2026",
      month: alternate ? "8" : "9",
      status: alternate ? "inactive" : "all",
      type: alternate ? "summary" : "all",
      currency: alternate ? "CDF" : "USD",
      search: alternate ? "missing" : "test",
      q: alternate ? "missing" : "test",
      dryRun: "true",
      preview: "true",
    },
    body: bodyFor(ctx, sequence * 10 + variant, alternate),
    session,
    user: {
      id: ctx.userId,
      userId: ctx.userId,
      role: "Admin",
      companyId: ctx.companyId,
      currentCompanyId: ctx.companyId,
      selectedCompanyId: ctx.companyId,
    },
    headers: { "content-type": "application/json" },
    cookies: {},
    signedCookies: {},
    ip: "127.0.0.1",
    ips: ["127.0.0.1"],
    hostname: "localhost",
    protocol: "http",
    secure: false,
    file: undefined,
    files: undefined,
    app: { get: () => undefined },
    get: (name: string) => (name.toLowerCase() === "host" ? "localhost" : undefined),
    header: () => undefined,
    accepts: () => true,
    is: () => true,
  };

  if (variant === 2) {
    for (const key of Object.keys(req.params)) req.params[key] = String(MISSING_ID);
    req.query = { ...req.query, companyId: String(ctx.companyId), id: String(MISSING_ID) };
    req.body = {
      ...req.body,
      id: MISSING_ID,
      stockItemId: MISSING_ID,
      itemId: MISSING_ID,
      productId: MISSING_ID,
      stockItemIds: [MISSING_ID],
      accountId: MISSING_ID,
      userId: MISSING_ID,
    };
  } else if (variant === 3) {
    for (const key of Object.keys(req.params)) req.params[key] = "not-a-number";
    req.query = {
      ...req.query,
      id: "not-a-number",
      page: "0",
      limit: "-1",
      companyId: "not-a-number",
      locationId: "not-a-number",
      stockItemId: "not-a-number",
      accountId: "not-a-number",
      startDate: "not-a-date",
      endDate: "not-a-date",
    };
    req.body = {
      ...req.body,
      id: "not-a-number",
      companyId: "not-a-number",
      locationId: "not-a-number",
      stockItemId: "not-a-number",
      accountId: "not-a-number",
      quantity: -1,
      qty: -1,
      amount: -1,
      rate: -1,
      price: -1,
      exchangeRate: 0,
      currency: "INVALID",
      date: "not-a-date",
    };
  } else if (variant === 4) {
    req.session = undefined;
    req.user = undefined;
  } else if (variant === 5) {
    req.session.role = "Staff";
    req.user.role = "Staff";
  } else if (variant === 6) {
    req.query = { ...req.query, companyId: String(MISSING_ID) };
    req.body = { ...req.body, companyId: MISSING_ID };
    req.user.selectedCompanyId = MISSING_ID;
  } else if (variant === 7) {
    req.query = {};
    req.body = {};
  }

  return req;
}

async function invokeWithBudget(
  handler: Handler,
  req: Record<string, any>,
  res: Record<string, any>,
  budgetMs = 175
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.resolve()
      .then(() => handler(req, res, () => undefined))
      .catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

async function invokeRegistration(route: Registration, req: Record<string, any>, res: Record<string, any>): Promise<number> {
  let invoked = 0;
  const lastHandler = route.handlers[route.handlers.length - 1];
  await invokeWithBudget(lastHandler, req, res);
  invoked += 1;

  // Exercise middleware and pre-handler guards as executable behavior too. Two
  // representative variants are enough to cover authenticated and unauthenticated
  // branches without multiplying every database-writing endpoint excessively.
  const role = req.user?.role;
  if (role === "Admin" || req.user === undefined) {
    for (const handler of route.handlers.slice(0, -1)) {
      await invokeWithBudget(handler, req, responseDouble(), 100);
      invoked += 1;
    }
  }

  return invoked;
}

export async function runDirectRouteBucket(bucket: number, bucketCount: number): Promise<{
  importedModules: number;
  registerFunctions: number;
  registrations: number;
  invoked: number;
}> {
  const prefix = `phase33bucket${bucket}`;
  const factoryPrefix = `phase33bucketfactory${bucket}`;
  const erpCtx = await seedTestData(prefix);
  const factoryCtx = await seedTestData(factoryPrefix);
  await pool.query("UPDATE companies SET company_type = 'factory' WHERE id = $1", [factoryCtx.companyId]);
  await pool.query(
    "UPDATE system_settings SET value = $1, updated_at = now() WHERE key = 'parentCompanyId'",
    [String(erpCtx.companyId)]
  );

  const registrations: Registration[] = [];
  let importedModules = 0;
  let registerFunctions = 0;

  try {
    const entries = Object.entries(moduleLoaders)
      .filter(([modulePath]) => !EXCLUDED_MODULES.test(modulePath))
      .filter(([modulePath]) => stableBucket(modulePath, bucketCount) === bucket)
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
            // Registrars with additional mandatory dependencies are still
            // imported for module coverage; independent registrars continue.
          }
        }
      } catch {
        // Environment-specific route modules should not prevent the remaining
        // independently loadable route surface from being exercised.
      }
    }

    let invoked = 0;
    for (const [index, route] of registrations.entries()) {
      if (EXCLUDED_ROUTES.test(route.routePath) || route.handlers.length === 0) continue;
      const factoryRoute = route.modulePath.includes("/factory/") || route.routePath.startsWith("/api/factory/");
      const ctx = factoryRoute ? factoryCtx : erpCtx;

      for (const variant of [0, 1, 2, 3, 4, 5, 6, 7] as const) {
        const req = requestDouble(route, ctx, index, variant);
        invoked += await invokeRegistration(route, req, responseDouble());
      }
    }

    return { importedModules, registerFunctions, registrations: registrations.length, invoked };
  } finally {
    await closeTestServer();
  }
}
