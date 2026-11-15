// Extracted from ./groupNetPosition.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { storage } from "../storage";
import type { HistoricalCurrencyReadiness } from "../services/accounting/historicalCurrencyReadiness";
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
import type { NetPositionLineItem } from "./calculateNetPositionAsOf";

export type CompanyRecord = Awaited<ReturnType<typeof storage.getAllCompanies>>[number];

export interface NetProfitRequest {
  method: string;
  path: string;
  session: { currentCompanyId: number };
  query: Record<string, string>;
}

export interface NetProfitResponse {
  status(code: number): NetProfitResponse;
  json(body: unknown): NetProfitResponse;
}

type NetProfitHandler = (
  req: NetProfitRequest,
  res: NetProfitResponse,
  next?: (error?: unknown) => unknown
) => unknown | Promise<unknown>;

const EXCLUDED_COMPANY_TYPES = new Set(["factory", "factory_v2", "supplier_partner"]);

export const EXCLUDED_COMPANY_TYPE_LIST = ["factory", "factory_v2", "supplier_partner"];

const EXCLUDED_COMPANY_CODES = new Set(["JNAH"]);

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
    mode: "paired-elimination";
    /** The amount eliminated from each side: the matched part of every intercompany pair. */
    additionalElimination: number;
    /** Each set of companies linked by intercompany accounts, with what matched and what did not. */
    pairs: GroupIntercompanyPair[];
    /** "Intercompany difference" lines: unmatched or mismatched amounts, included in the group totals. */
    differences: NetPositionLineItem[];
    note: string;
  };
}

export interface GroupIntercompanyPair {
  companyIds: number[];
  companyNames: string[];
  accounts: Array<{ companyId: number; accountId: number; accountName: string; balance: number }>;
  /** Each company's net balance with the other(s) of the pair, receivable positive (wave 17 A). */
  byCompany: Array<{ companyId: number; companyName: string; net: number }>;
  /** Sum of the companies' receivable (debit) nets and of their payable (credit) nets. */
  receivables: number;
  payables: number;
  eliminated: number;
  /** receivables − payables: zero when the pair matches. */
  difference: number;
  status: "matched" | "mismatched" | "unpaired";
}

export const INTERCOMPANY_DIFFERENCE_LABEL = "Intercompany difference";

export function isGroupNetPositionCompany(company: Pick<CompanyRecord, "active" | "companyType" | "code">): boolean {
  const companyCode = String(company.code ?? "")
    .trim()
    .toUpperCase();
  return (
    company.active !== false &&
    !EXCLUDED_COMPANY_TYPES.has(company.companyType || "") &&
    !EXCLUDED_COMPANY_CODES.has(companyCode)
  );
}

/**
 * Group Net Position is an intentional cross-company read. The HTTP request itself
 * is scoped to the company currently selected in the browser, but every company
 * snapshot below must run under that company's own PostgreSQL RLS scope. Without
 * re-rooting both AsyncLocalStorage contexts, sister companies can look empty until
 * the user manually switches into them.
 */
export async function runWithGroupCompanyScope<T>(
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

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
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

export async function runNetProfitPipeline(req: NetProfitRequest, res: NetProfitResponse): Promise<void> {
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

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
