import type { Express } from "express";
import { storage } from "../storage";
import { round2 } from "../netPositionHelper";
import {
  getHistoricalCurrencyReadiness,
  type HistoricalCurrencyReadiness,
} from "../services/accounting/historicalCurrencyReadiness";
import { registerGoldenCoastResidualEquityProjection } from "../routes/stats/goldenCoastResidualEquityProjection";
import { registerStatsMultiCurrencyRoutes } from "../routes/stats/statsMultiCurrencyRoutes";
import { registerStatsNetProfitRoutes } from "../routes/stats/statsNetProfitRoutes";
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

const EXCLUDED_COMPANY_TYPES = new Set(["properties", "factory", "factory_v2"]);
const EXCLUDED_COMPANY_TYPE_LIST = ["properties", "factory", "factory_v2"];

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
 * and is post-processed by the current cash/bank translation middleware plus the
 * Golden Coast Supplier Partner projection. Capturing those registered handlers
 * here avoids maintaining a second, drifting balance-sheet implementation.
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

  // Keep the same order as server/routes/statsRoutes.ts. The response wrappers
  // intentionally unwind in reverse order.
  registerGoldenCoastResidualEquityProjection(captureApp);
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

async function assertHistoricalCurrencyReady(companies: CompanyRecord[], asOfDate: string): Promise<void> {
  await mapWithConcurrency(companies, 3, async (company) => {
    const readiness = await getHistoricalCurrencyReadiness(company.id, asOfDate);
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

  await assertHistoricalCurrencyReady(companies, asOfDate);

  const companyPositions = await mapWithConcurrency(companies, 3, async (company) => {
    const snapshot = await calculateErpNetPosition(company.id, asOfDate, useCurrentSnapshot);
    const sideNetPosition = round2(snapshot.forUsTotal - snapshot.onUsTotal);
    const netAdjustment = round2(snapshot.netPosition - sideNetPosition);

    return {
      companyId: company.id,
      companyCode: company.code,
      companyName: company.name,
      companyType: company.companyType,
      forUsTotal: snapshot.forUsTotal,
      onUsTotal: snapshot.onUsTotal,
      sideNetPosition,
      netAdjustment,
      netPosition: snapshot.netPosition,
      netPositionLabel: snapshot.netPositionLabel,
      forUsLines: snapshot.forUsLines,
      onUsLines: snapshot.onUsLines,
    } satisfies GroupNetPositionCompany;
  });

  const forUsTotal = round2(companyPositions.reduce((sum, company) => sum + company.forUsTotal, 0));
  const onUsTotal = round2(companyPositions.reduce((sum, company) => sum + company.onUsTotal, 0));
  const sideNetPosition = round2(forUsTotal - onUsTotal);
  const companyNetTotal = round2(companyPositions.reduce((sum, company) => sum + company.netPosition, 0));
  const netAdjustments = round2(companyNetTotal - sideNetPosition);

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
      netPosition: companyNetTotal,
    },
    intercompany: {
      mode: "already-excluded",
      additionalElimination: 0,
      note: "Normal Intercompany ledger accounts are already excluded by the ERP Net Position rules, so no second group-level elimination is applied.",
    },
  };
}
