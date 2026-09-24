import type { Express } from "express";
import { storage } from "../storage";
import { round2 } from "../netPositionHelper";
import {
  getHistoricalCurrencyReadiness,
  type HistoricalCurrencyReadiness,
} from "../services/accounting/historicalCurrencyReadiness";
import { registerStatsMultiCurrencyRoutes } from "../routes/stats/statsMultiCurrencyRoutes";
import { registerStatsNetProfitRoutes } from "../routes/stats/statsNetProfitRoutes";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../services/security/companyRequestRuntimeContext";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../services/security/databaseScopeRuntimeContext";
import type { NetPositionLineItem, NetPositionSnapshot } from "./calculateNetPositionAsOf";

type CompanyRecord = Awaited<ReturnType<typeof storage.getAllCompanies>>[number];

interface NetProfitRequest {
  method: string;
  path: string;
  session: { currentCompanyId: number };
  query: Record<string, string>;
}

interface NetProfitResponse {
  status(code: number): NetProfitResponse;
  json(body: unknown): NetProfitResponse;
}

type NetProfitHandler = (
  req: NetProfitRequest,
  res: NetProfitResponse,
  next?: (error?: unknown) => unknown
) => unknown | Promise<unknown>;

const EXCLUDED_COMPANY_TYPES = new Set(["properties", "factory", "factory_v2", "supplier_partner"]);
const EXCLUDED_COMPANY_TYPE_LIST = ["properties", "factory", "factory_v2", "supplier_partner"];

export class GroupHistoricalCurrencyError extends Error {
  constructor(
    public readonly companyId: number,
    public readonly companyName: string,
    public readonly readiness: HistoricalCurrencyReadiness
  ) {
    super(`Historical currency data is unresolved for ${companyName}`);
    this.name = "GroupHistoricalCurrencyError";
  }
}

export interface GroupNetPositionCompany {
  companyId: number;
  companyCode: string;
  companyName: string;
  companyType: string;
  forUsTotal: number;
  onUsTotal: number;
  sideNetPosition: number;
  netAdjustment: number;
  netPosition: number;
  netPositionLabel: string;
  forUsLines: NetPositionLineItem[];
  onUsLines: NetPositionLineItem[];
}

export interface GroupNetPositionSnapshot {
  asOfDate: string;
  companyCount: number;
  excludedCompanyTypes: string[];
  companies: GroupNetPositionCompany[];
  totals: {
    forUsTotal: number;
    onUsTotal: number;
    sideNetPosition: number;
    netAdjustments: number;
    netPosition: number;
  };
  intercompany: {
    mode: "already-excluded";
    additionalElimination: 0;
    note: string;
  };
}

export function isGroupNetPositionCompany(company: Pick<CompanyRecord, "active" | "companyType">): boolean {
  return company.active !== false && !EXCLUDED_COMPANY_TYPES.has(company.companyType || "");
}

/**
 * Group Net Position is an intentional cross-company read. The HTTP request itself
 * is scoped to the company currently selected in the browser, but every company
 * snapshot below must run under that company's own PostgreSQL RLS scope. Without
 * re-rooting both AsyncLocalStorage contexts, sister companies can look empty until
 * the user manually switches into them.
 */
async function runWithGroupCompanyScope<T>(
  companyId: number,
  allowedCompanyIds: ReadonlySet<number> | undefined,
  run: () => Promise<T>
): Promise<T> {
  if (allowedCompanyIds !== undefined && !allowedCompanyIds.has(companyId)) {
    throw new Error(`Company ${companyId} is outside the authorized Group Net Position scope`);
  }

  const requestContext = getCompanyRequestRuntimeContext();
  const authorizedCompanyIds = allowedCompanyIds
    ? [...allowedCompanyIds].filter((id) => id !== companyId)
    : requestContext
      ? [...new Set([requestContext.companyId, ...(requestContext.authorizedCompanyIds ?? [])])].filter(
          (id) => id !== companyId
        )
      : [];

  const databaseScope = createTenantDatabaseScope(companyId, authorizedCompanyIds, "active-company");
  const runInDatabaseScope = () => runWithDatabaseScopeRuntimeContext(databaseScope, run);

  if (!requestContext) return runInDatabaseScope();

  return runWithCompanyRequestRuntimeContext(
    {
      ...requestContext,
      companyId,
      authorizedCompanyIds,
    },
    runInDatabaseScope
  );
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

type CapturedNetProfitPipeline = {
  middleware: NetProfitHandler[];
  routeHandler: NetProfitHandler;
};

let capturedNetProfitPipeline: CapturedNetProfitPipeline | null = null;

/**
 * Group Net Position must use the exact ERP Net Position presentation that users
 * see on the normal Net Position page. That page is backed by /api/stats/net-profit
 * and is post-processed by the current cash/bank translation middleware. Supplier
 * Partner companies are excluded before this pipeline is invoked, so their special
 * presentation rules cannot leak into Group Net Position.
 */
function getNetProfitPipeline(): CapturedNetProfitPipeline {
  if (capturedNetProfitPipeline) return capturedNetProfitPipeline;

  const middleware: NetProfitHandler[] = [];
  let routeHandler: NetProfitHandler | null = null;

  const captureApp = {
    use(pathOrHandler: string | NetProfitHandler, ...handlers: NetProfitHandler[]) {
      if (typeof pathOrHandler === "function") {
        middleware.push(pathOrHandler, ...handlers);
      } else if (pathOrHandler === "/api/stats/net-profit") {
        middleware.push(...handlers);
      }
      return captureApp;
    },
    get(path: string, ...handlers: NetProfitHandler[]) {
      if (path === "/api/stats/net-profit") {
        routeHandler = handlers[handlers.length - 1] ?? null;
      }
      return captureApp;
    },
    post() {
      return captureApp;
    },
    put() {
      return captureApp;
    },
    patch() {
      return captureApp;
    },
    delete() {
      return captureApp;
    },
  } as unknown as Express;

  // Keep the ERP response wrappers in the same order as server/routes/statsRoutes.ts.
  // Supplier Partner projection is deliberately omitted because SP companies are
  // not eligible for Group Net Position.
  registerStatsMultiCurrencyRoutes(captureApp);
  registerStatsNetProfitRoutes(captureApp);

  if (!routeHandler) throw new Error("ERP Net Position handler is unavailable");
  capturedNetProfitPipeline = { middleware, routeHandler };
  return capturedNetProfitPipeline;
}

async function runNetProfitPipeline(req: NetProfitRequest, res: NetProfitResponse): Promise<void> {
  const { middleware, routeHandler } = getNetProfitPipeline();
  const handlers = [...middleware, routeHandler];

  const dispatch = async (index: number): Promise<void> => {
    const handler = handlers[index];
    if (!handler) return;

    let nextPromise: Promise<void> | null = null;
    const next = (error?: unknown) => {
      if (error) return Promise.reject(error);
      nextPromise = dispatch(index + 1);
      return nextPromise;
    };

    await handler(req, res, next);
    if (nextPromise) await nextPromise;
  };

  await dispatch(0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toLineItem(account: unknown, side: "forUs" | "onUs"): NetPositionLineItem {
  const row = asRecord(account);
  return {
    label: String(row.name ?? row.label ?? "Unnamed"),
    value: round2(Number(row.value ?? 0) || 0),
    category: String(row.category ?? "Other"),
    side,
  };
}

async function calculateErpNetPosition(
  companyId: number,
  asOfDate: string,
  useCurrentSnapshot: boolean
): Promise<NetPositionSnapshot> {
  let responseBody: unknown = null;
  let statusCode = 200;

  const req: NetProfitRequest = {
    method: "GET",
    path: "/api/stats/net-profit",
    session: { currentCompanyId: companyId },
    query: useCurrentSnapshot ? {} : { toDate: asOfDate },
  };
  const response: NetProfitResponse = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: unknown) {
      responseBody = body;
      return response;
    },
  };

  await runNetProfitPipeline(req, response);
  const body = asRecord(responseBody);
  if (statusCode >= 400 || Object.keys(body).length === 0) {
    throw new Error(String(body.message ?? `ERP Net Position failed with status ${statusCode}`));
  }

  const forUs = asRecord(body.forUs);
  const onUs = asRecord(body.onUs);
  const forUsTotal = round2(Number(body.forUsTotal ?? forUs.total ?? 0) || 0);
  const onUsTotal = round2(Number(body.onUsTotal ?? onUs.total ?? 0) || 0);
  const netPosition = round2(Number(body.netPosition ?? forUsTotal - onUsTotal) || 0);
  const forUsAccounts = Array.isArray(forUs.accounts) ? forUs.accounts : [];
  const onUsAccounts = Array.isArray(onUs.accounts) ? onUs.accounts : [];

  return {
    forUsTotal,
    onUsTotal,
    netPosition,
    netPositionLabel: String(
      body.netPositionLabel ?? (netPosition >= 0 ? "We have more than we owe" : "We owe more than we have")
    ),
    forUsLines: forUsAccounts.map((account) => toLineItem(account, "forUs")),
    onUsLines: onUsAccounts.map((account) => toLineItem(account, "onUs")),
  };
}

async function assertHistoricalCurrencyReady(
  companies: CompanyRecord[],
  asOfDate: string,
  allowedCompanyIds?: ReadonlySet<number>
): Promise<void> {
  await mapWithConcurrency(companies, 3, async (company) => {
    const readiness = await runWithGroupCompanyScope(company.id, allowedCompanyIds, () =>
      getHistoricalCurrencyReadiness(company.id, asOfDate)
    );
    if (!readiness.ready) {
      throw new GroupHistoricalCurrencyError(company.id, company.name, readiness);
    }
  });
}

export async function calculateGroupNetPosition(
  asOfDate: string,
  allowedCompanyIds?: ReadonlySet<number>,
  useCurrentSnapshot = false
): Promise<GroupNetPositionSnapshot> {
  const companies = (await storage.getAllCompanies())
    .filter(isGroupNetPositionCompany)
    .filter((company) => allowedCompanyIds === undefined || allowedCompanyIds.has(company.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  await assertHistoricalCurrencyReady(companies, asOfDate, allowedCompanyIds);

  const companyPositions = await mapWithConcurrency(companies, 3, async (company) => {
    const snapshot = await runWithGroupCompanyScope(company.id, allowedCompanyIds, () =>
      calculateErpNetPosition(company.id, asOfDate, useCurrentSnapshot)
    );

    // Group Net Position is intentionally the aggregate ERP balance sheet:
    // What We Have minus What We Owe. Supplier Partner/equity adjustments are
    // outside this report and ordinary Intercompany accounts are already omitted
    // by the shared Net Position classifier.
    const sideNetPosition = round2(snapshot.forUsTotal - snapshot.onUsTotal);

    return {
      companyId: company.id,
      companyCode: company.code,
      companyName: company.name,
      companyType: company.companyType,
      forUsTotal: snapshot.forUsTotal,
      onUsTotal: snapshot.onUsTotal,
      sideNetPosition,
      netAdjustment: 0,
      netPosition: sideNetPosition,
      netPositionLabel: sideNetPosition >= 0 ? "We have more than we owe" : "We owe more than we have",
      forUsLines: snapshot.forUsLines,
      onUsLines: snapshot.onUsLines,
    } satisfies GroupNetPositionCompany;
  });

  const forUsTotal = round2(companyPositions.reduce((sum, company) => sum + company.forUsTotal, 0));
  const onUsTotal = round2(companyPositions.reduce((sum, company) => sum + company.onUsTotal, 0));
  const sideNetPosition = round2(forUsTotal - onUsTotal);
  const netAdjustments = 0;

  return {
    asOfDate,
    companyCount: companyPositions.length,
    excludedCompanyTypes: [...EXCLUDED_COMPANY_TYPE_LIST],
    companies: companyPositions,
    totals: {
      forUsTotal,
      onUsTotal,
      sideNetPosition,
      netAdjustments,
      netPosition: sideNetPosition,
    },
    intercompany: {
      mode: "already-excluded",
      additionalElimination: 0,
      note: "Intercompany ledger accounts are excluded by the ERP Net Position classifier before each company total is returned, so they are not included in Group Net Position.",
    },
  };
}
