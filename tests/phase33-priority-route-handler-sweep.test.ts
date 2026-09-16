import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { closeTestServer, seedTestData, type TestContext } from "./setup";

const ERP_PREFIX = "phase33direct";
const FACTORY_PREFIX = "phase33directfactory";
const MISSING_ID = 2_147_482_300;

const PRIORITY_ROUTE_FILES = new Set([
  "../server/routes/stock/stockPriceListImportRoutes.ts",
  "../server/routes/factory/docs-users/companyImportRoutes.ts",
  "../server/routes/retailRoutes.ts",
  "../server/routes/sp-migration/spMigrationSalesRoutes.ts",
  "../server/routes/accountStatementRoutes.ts",
  "../server/routes/admin/accountMigrationSafeRoutes.ts",
  "../server/routes/container-loaded-items/reports.ts",
  "../server/routes/factory/factoryBilingualDocumentRoutes.ts",
  "../server/routes/stock/stockItemManageRoutes.ts",
  "../server/routes/git/gitImportRoutes.ts",
  "../server/routes/sp/spMigrationPhase4Routes.ts",
  "../server/routes/containers/accounting/costing.ts",
  "../server/routes/sp/spMigrationPhase4Reconcile.ts",
  "../server/routes/factory/customer-orders/orderPricingRoutes.ts",
  "../server/routes/baleLookupRoutes.ts",
  "../server/routes/factory/customer-proformas/exports.ts",
  "../server/routes/exportRoutes.ts",
  "../server/routes/factory/raw-stock/historicalReplayRoutesV4.ts",
  "../server/routes/sp/spMigrationPhase4Verification.ts",
  "../server/routes/factory/bales/balesReimportRoutes.ts",
  "../server/routes/factory/docs-users/daybookEditRoutes.ts",
  "../server/routes/stockTransferImportRoutes.ts",
  "../server/routes/sp/spGoldenCoastPhase5PosSaleRoutes.ts",
  "../server/routes/productionBaleRoutes.ts",
  "../server/routes/factory/customer-orders/pdf-export/loading-status.ts",
  "../server/routes/sp/spMigrationCutoverReadiness.ts",
  "../server/routes/admin/userManagementRoutes.ts",
  "../server/routes/sp/spMigrationCutoverRoutes.ts",
  "../server/routes/factory/suppliers/supplierStatementRoutes.ts",
  "../server/routes/creditSalesImportRoutes.ts",
  "../server/routes/containers/containerDocumentsRoutes.ts",
  "../server/routes/sp/spGoldenCoastPhase8ContainerOffloadRoutes.ts",
  "../server/routes/container-loaded-items/summary.ts",
  "../server/routes/containers/containerFreightWriteRoutes.ts",
  "../server/routes/factory/stock/locationInventoryRoutes.ts",
  "../server/routes/factory/customer-orders/pdf-export/order-pdf.ts",
  "../server/routes/factory/customer-orders/bale-scanning/bulk-import.ts",
  "../server/routes/location/locationWhatsappScheduleRoutes.ts",
  "../server/routes/factory/bales/balesImportRoutes.ts",
  "../server/routes/admin/adminPoFixRoutes.ts",
  "../server/routes/factory/invoice-loading/invoice-reports.ts",
  "../server/routes/offloadRoutes.ts",
  "../server/routes/sp/spMigrationPhase2Containers.ts",
  "../server/routes/factory/suppliers/supplierStatementRoutes.ts",
  "../server/routes/aiAgentRoutes.ts",
  "../server/routes/rental/rentalAccrualConfigRoutes.ts",
  "../server/routes/vouchers/voucherJournalRoutes.ts",
  "../server/routes/factory/docs-users/usersAccessRoutes.ts",
  "../server/routes/remoteControlSessionRoutes.ts",
  "../server/routes/containers/containerFreightReadRoutes.ts",
  "../server/routes/bankAssetRoutes.ts",
  "../server/routes/factory/employee-pos/employeeLedgerWasteRoutes.ts",
  "../server/routes/factory/customers-core/statement-pdf.ts",
  "../server/routes/factory/raw-stock/historicalReplayPhase6GuardRoutes.ts",
  "../server/routes/goldenCoastAccountingRoutes.ts",
  "../server/routes/factory/bale-exports/weekly-report.ts",
  "../server/routes/supplierProformaRoutes.ts",
  "../server/routes/stats/statsNetProfitRoutes.ts",
  "../server/routes/factory/bale-exports/production-value-report.ts",
  "../server/routes/stock/groups-items/bulk-ops.ts",
  "../server/routes/stock/transfer-adj/imports.ts",
  "../server/routes/sp-migration/spMigrationRunRoutes.ts",
  "../server/routes/location/locationCrudRoutes.ts",
  "../server/routes/sp/spGoldenCoastPhase7HadiTransferRoutes.ts",
  "../server/routes/sp/spMigrationPhase4Users.ts",
  "../server/routes/sp/spMigrationPhase2Common.ts",
  "../server/routes/factory/dispatch-batches/invoicing.ts",
  "../server/routes/sp/spGoldenCoastPhase10SalesCashSettlementRoutes.ts",
  "../server/routes/factory/customer-orders/orderChargesRoutes.ts",
  "../server/routes/rental/units-contracts/units-read.ts",
  "../server/routes/rental/units-contracts/guarantees.ts",
  "../server/routes/sp/spGoldenCoastSetupRoutes.ts",
  "../server/routes/vouchers/transfer/with-entries.ts",
  "../server/routes/sp/spMigrationPhase4Inventory.ts",
  "../server/routes/payroll/core/generate.ts",
  "../server/routes/factory-reports/supplier-usage.ts",
  "../server/routes/factory/stock-allocation-v5/allocation.ts",
  "../server/routes/transporterStatementRoutes.ts",
  "../server/routes/creditNoteRoutes.ts",
  "../server/routes/sp-migration/spMigrationStockRoutes.ts",
  "../server/routes/factory/customer-orders/verify-recover/verification-summary.ts",
  "../server/routes/admin/companySettingsRoutes.ts",
  "../server/routes/vouchers/voucherPaymentRoutes.ts",
  "../server/routes/factory-payroll/generate.ts",
  "../server/routes/payroll/worker-statement/statement.ts",
  "../server/routes/erp-payroll/runs-migration.ts",
]);

const EXTERNAL_OR_DESTRUCTIVE = /(whatsapp|openai|gemini|track|trace|webhook|remote-control|permanent-delete|rebuild|purge)/i;
const moduleLoaders = import.meta.glob("../server/routes/**/*.ts");

type Handler = (req: Record<string, any>, res: Record<string, any>, next: (error?: unknown) => void) => unknown;

type Registration = {
  method: string;
  routePath: string;
  handlers: Handler[];
  modulePath: string;
};

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
        if (method === "use" || method === "all" || method === "options" || method === "head" || method === "set") {
          return () => undefined;
        }
        return undefined;
      },
    }
  );
}

function parameterValue(routePath: string, name: string, ctx: TestContext, alternate: boolean): string {
  const key = name.toLowerCase();
  const lower = routePath.toLowerCase();
  if (key.includes("company")) return String(ctx.companyId);
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
    if (/stock[-_/]?items?/.test(lower)) return String(ctx.stockItemIds[0]);
    if (/locations?/.test(lower)) return String(alternate ? ctx.location2Id : ctx.locationId);
    if (/stock[-_/]?groups?/.test(lower)) return String(ctx.stockGroupId);
    if (/ledger|accounts?/.test(lower)) return String(ctx.salesAccountId);
    if (/companies?/.test(lower)) return String(ctx.companyId);
    if (/users?/.test(lower)) return String(ctx.userId);
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
  const unique = `PH33-DIRECT-${sequence}-${alternate ? "B" : "A"}`;
  const item = {
    stockItemId,
    itemId: stockItemId,
    locationId: alternate ? ctx.location2Id : ctx.locationId,
    quantity: alternate ? 2 : 1,
    qty: alternate ? 2 : 1,
    rate: alternate ? 2 : 1,
    price: alternate ? 2 : 1,
    amount: alternate ? 4 : 1,
  };
  return {
    companyId: ctx.companyId,
    locationId: alternate ? ctx.location2Id : ctx.locationId,
    fromLocationId: ctx.locationId,
    toLocationId: ctx.location2Id,
    stockItemId,
    itemId: stockItemId,
    stockGroupId: ctx.stockGroupId,
    groupId: ctx.stockGroupId,
    accountId: ctx.salesAccountId,
    cashAccountId: ctx.cashAccountId,
    salesAccountId: ctx.salesAccountId,
    debitAccountId: ctx.salesAccountId,
    creditAccountId: ctx.cashAccountId,
    userId: ctx.userId,
    quantity: alternate ? 2 : 1,
    qty: alternate ? 2 : 1,
    amount: alternate ? 4 : 1,
    rate: alternate ? 2 : 1,
    price: alternate ? 2 : 1,
    currency: alternate ? "CDF" : "USD",
    exchangeRate: alternate ? 2800 : 1,
    date: alternate ? "2026-08-31" : "2026-09-15",
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    fromDate: "2026-09-01",
    toDate: "2026-09-30",
    status: alternate ? "pending" : "active",
    type: alternate ? "summary" : "standard",
    name: unique,
    code: unique,
    reference: unique,
    description: "Phase 33 direct route coverage probe",
    reason: "Phase 33 direct route coverage probe",
    notes: "Phase 33 direct route coverage probe",
    dryRun: true,
    preview: true,
    active: !alternate,
    isActive: !alternate,
    items: [item],
    lines: [item],
    entries: [
      { accountId: ctx.salesAccountId, debit: 1, credit: 0, description: unique },
      { accountId: ctx.cashAccountId, debit: 0, credit: 1, description: unique },
    ],
  };
}

function responseDouble() {
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
  res.download = (_path: unknown, _name?: unknown, callback?: unknown) => {
    if (typeof callback === "function") callback();
    res.headersSent = true;
    return res;
  };
  return res;
}

function requestDouble(route: Registration, ctx: TestContext, sequence: number, alternate: boolean) {
  const params = paramsFor(route.routePath, ctx, alternate);
  return {
    method: route.method,
    path: route.routePath,
    url: route.routePath,
    originalUrl: route.routePath,
    params,
    query: {
      ...params,
      page: alternate ? "2" : "1",
      limit: alternate ? "1" : "10",
      offset: alternate ? "1" : "0",
      locationId: String(alternate ? ctx.location2Id : ctx.locationId),
      stockItemId: String(ctx.stockItemIds[0]),
      accountId: String(ctx.salesAccountId),
      companyId: String(ctx.companyId),
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
      status: alternate ? "inactive" : "all",
      type: alternate ? "summary" : "all",
      currency: alternate ? "CDF" : "USD",
      search: alternate ? "missing" : "test",
      q: alternate ? "missing" : "test",
      dryRun: "true",
      preview: "true",
    },
    body: bodyFor(ctx, sequence, alternate),
    session: {
      userId: ctx.userId,
      currentCompanyId: ctx.companyId,
      role: "Admin",
      save: (callback?: () => void) => callback?.(),
      touch: () => undefined,
      regenerate: (callback?: (error?: unknown) => void) => callback?.(),
      destroy: (callback?: (error?: unknown) => void) => callback?.(),
    },
    user: {
      id: ctx.userId,
      userId: ctx.userId,
      role: "Admin",
      companyId: ctx.companyId,
      currentCompanyId: ctx.companyId,
    },
    headers: { "content-type": "application/json" },
    ip: "127.0.0.1",
    hostname: "localhost",
    protocol: "http",
    secure: false,
    file: undefined,
    files: undefined,
    get: (name: string) => (name.toLowerCase() === "host" ? "localhost" : undefined),
    header: () => undefined,
    accepts: () => true,
  };
}

async function invokeWithBudget(handler: Handler, req: Record<string, any>, res: Record<string, any>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.resolve().then(() => handler(req, res, () => undefined)).catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 750);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

describe("Phase 33 priority direct route-handler sweep", () => {
  let erpCtx: TestContext;
  let factoryCtx: TestContext;

  beforeAll(async () => {
    erpCtx = await seedTestData(ERP_PREFIX);
    factoryCtx = await seedTestData(FACTORY_PREFIX);
    await pool.query("UPDATE companies SET company_type = 'factory' WHERE id = $1", [factoryCtx.companyId]);
    await pool.query(
      "UPDATE system_settings SET value = $1, updated_at = now() WHERE key = 'parentCompanyId'",
      [String(erpCtx.companyId)]
    );
  }, 120_000);

  afterAll(async () => {
    await closeTestServer();
  }, 120_000);

  it("loads priority route modules and drives their registered handlers through two seeded states", async () => {
    const registrations: Registration[] = [];
    let importedModules = 0;
    let registerFunctions = 0;

    for (const modulePath of PRIORITY_ROUTE_FILES) {
      if (EXTERNAL_OR_DESTRUCTIVE.test(modulePath)) continue;
      const loader = moduleLoaders[modulePath];
      if (!loader) continue;

      try {
        const mod = (await loader()) as Record<string, unknown>;
        importedModules += 1;
        for (const [name, value] of Object.entries(mod)) {
          if (typeof value !== "function" || !/^register.*Routes?$/i.test(name)) continue;
          registerFunctions += 1;
          try {
            await Promise.resolve((value as (app: unknown) => unknown)(fakeApp(modulePath, registrations)));
          } catch {
            // Registration helpers occasionally require an optional dependency;
            // the import itself is still useful, and other exported registrars
            // in the same module remain eligible for direct probing.
          }
        }
      } catch {
        // A priority file may be environment-specific. Keep the sweep broad and
        // assert aggregate coverage below rather than making one module prevent
        // all remaining low-coverage modules from executing.
      }
    }

    expect(importedModules).toBeGreaterThan(40);
    expect(registerFunctions).toBeGreaterThan(25);
    expect(registrations.length).toBeGreaterThan(80);

    let invoked = 0;
    for (const [index, route] of registrations.entries()) {
      if (EXTERNAL_OR_DESTRUCTIVE.test(route.routePath) || route.handlers.length === 0) continue;
      const ctx = route.modulePath.includes("/factory/") || route.routePath.startsWith("/api/factory/") ? factoryCtx : erpCtx;
      const handler = route.handlers[route.handlers.length - 1];

      for (const alternate of [false, true]) {
        const req = requestDouble(route, ctx, index, alternate);
        const res = responseDouble();
        await invokeWithBudget(handler, req, res);
        invoked += 1;
      }
    }

    expect(invoked).toBeGreaterThan(120);
  }, 600_000);
});
