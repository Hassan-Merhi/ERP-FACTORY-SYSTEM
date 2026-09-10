import type { Express } from "express";
import { storage } from "../storage";
import { round2 } from "../netPositionHelper";
import { getHistoricalCurrencyReadiness, type HistoricalCurrencyReadiness } from "../services/accounting/historicalCurrencyReadiness";
import { registerEmployeeNetPositionRoutes } from "../routes/factory/employee-pos/employeeNetPositionRoutes";
import { loadNetProfitData } from "../routes/stats/netProfitDataLoad";
import { projectGoldenCoastResidualEquity } from "../routes/stats/goldenCoastResidualEquityProjection";
import {
  calculateNetPositionAsOf,
  type NetPositionLineItem,
  type NetPositionSnapshot,
} from "./calculateNetPositionAsOf";

type CompanyRecord = Awaited<ReturnType<typeof storage.getAllCompanies>>[number];
type FactoryRouteHandler = (req: any, res: any) => unknown | Promise<unknown>;

const FACTORY_COMPANY_TYPES = new Set(["factory", "factory_v2"]);

export class GroupHistoricalCurrencyError extends Error {
  constructor(
    public readonly companyId: number,
    public readonly companyName: string,
    public readonly readiness: HistoricalCurrencyReadiness,
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
  return company.active !== false && company.companyType !== "properties";
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

let factoryNetPositionHandler: FactoryRouteHandler | null = null;

function getFactoryNetPositionHandler(): FactoryRouteHandler {
  if (factoryNetPositionHandler) return factoryNetPositionHandler;

  const captureApp = {
    get(path: string, ...handlers: FactoryRouteHandler[]) {
      if (path === "/api/factory/net-position") {
        factoryNetPositionHandler = handlers[handlers.length - 1] ?? null;
      }
      return captureApp;
    },
    post() { return captureApp; },
    put() { return captureApp; },
    patch() { return captureApp; },
    delete() { return captureApp; },
    use() { return captureApp; },
  } as unknown as Express;

  registerEmployeeNetPositionRoutes(captureApp);
  if (!factoryNetPositionHandler) {
    throw new Error("Factory Net Position handler is unavailable");
  }
  return factoryNetPositionHandler;
}

function toFactoryLineItem(account: any, side: "forUs" | "onUs"): NetPositionLineItem {
  return {
    label: String(account?.name ?? account?.label ?? "Unnamed"),
    value: round2(Number(account?.value ?? 0) || 0),
    category: String(account?.category ?? "Other"),
    side,
  };
}

async function calculateFactoryNetPositionAsOf(companyId: number, asOfDate: string): Promise<NetPositionSnapshot> {
  const handler = getFactoryNetPositionHandler();
  let responseBody: any = null;
  let statusCode = 200;

  const req = {
    session: { factoryCompanyId: companyId, currentCompanyId: companyId },
    query: { asOf: asOfDate },
  };
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      responseBody = body;
      return res;
    },
  };

  await handler(req, res);
  if (statusCode >= 400 || !responseBody) {
    throw new Error(responseBody?.message || `Factory Net Position failed with status ${statusCode}`);
  }

  const forUsTotal = round2(Number(responseBody.forUsTotal ?? responseBody.forUs?.total ?? 0) || 0);
  const onUsTotal = round2(Number(responseBody.onUsTotal ?? responseBody.onUs?.total ?? 0) || 0);
  const netPosition = round2(Number(responseBody.netPosition ?? forUsTotal - onUsTotal) || 0);
  const forUsAccounts = Array.isArray(responseBody.forUs?.accounts) ? responseBody.forUs.accounts : [];
  const onUsAccounts = Array.isArray(responseBody.onUs?.accounts) ? responseBody.onUs.accounts : [];

  return {
    forUsTotal,
    onUsTotal,
    netPosition,
    netPositionLabel: String(
      responseBody.netPositionLabel ?? (netPosition >= 0 ? "We have more than we owe" : "We owe more than we have"),
    ),
    forUsLines: forUsAccounts.map((account: any) => toFactoryLineItem(account, "forUs")),
    onUsLines: onUsAccounts.map((account: any) => toFactoryLineItem(account, "onUs")),
  };
}

function lineAccountsForProjection(lines: NetPositionLineItem[], companyAccounts: any[]) {
  const idsByName = new Map<string, number | null>();
  for (const account of companyAccounts) {
    const name = String(account?.name ?? "");
    if (!name) continue;
    if (idsByName.has(name)) idsByName.set(name, null);
    else idsByName.set(name, Number(account.id));
  }

  return lines.map((line) => {
    const id = idsByName.get(line.label);
    return {
      ...(typeof id === "number" && Number.isInteger(id) && id > 0 ? { id } : {}),
      name: line.label,
      value: line.value,
      category: line.category,
    };
  });
}

async function calculateSupplierPartnerNetPositionAsOf(
  companyId: number,
  asOfDate: string,
): Promise<NetPositionSnapshot> {
  const [snapshot, reportData] = await Promise.all([
    calculateNetPositionAsOf(companyId, asOfDate),
    loadNetProfitData(companyId, asOfDate),
  ]);

  const body = {
    forUs: {
      total: snapshot.forUsTotal,
      accounts: lineAccountsForProjection(snapshot.forUsLines, reportData.companyAccounts),
    },
    onUs: {
      total: snapshot.onUsTotal,
      accounts: lineAccountsForProjection(snapshot.onUsLines, reportData.companyAccounts),
    },
    forUsTotal: snapshot.forUsTotal,
    onUsTotal: snapshot.onUsTotal,
    netPosition: snapshot.netPosition,
    netPositionLabel: snapshot.netPositionLabel,
  };

  const projected = projectGoldenCoastResidualEquity({
    body,
    companyAccounts: reportData.companyAccounts,
    accountBalances: reportData.accountBalances,
  }) as any;

  const forUsTotal = round2(Number(projected.forUs?.total ?? projected.forUsTotal ?? snapshot.forUsTotal) || 0);
  const onUsTotal = round2(Number(projected.onUs?.total ?? projected.onUsTotal ?? snapshot.onUsTotal) || 0);
  const netPosition = round2(Number(projected.netPosition ?? forUsTotal - onUsTotal) || 0);
  const forUsAccounts = Array.isArray(projected.forUs?.accounts) ? projected.forUs.accounts : [];
  const onUsAccounts = Array.isArray(projected.onUs?.accounts) ? projected.onUs.accounts : [];

  return {
    forUsTotal,
    onUsTotal,
    netPosition,
    netPositionLabel: String(projected.netPositionLabel ?? (netPosition >= 0 ? "Net Assets" : "Net Liabilities")),
    forUsLines: forUsAccounts.map((account: any) => toFactoryLineItem(account, "forUs")),
    onUsLines: onUsAccounts.map((account: any) => toFactoryLineItem(account, "onUs")),
  };
}

async function calculateAuthoritativeNetPositionAsOf(
  company: CompanyRecord,
  asOfDate: string,
): Promise<NetPositionSnapshot> {
  if (FACTORY_COMPANY_TYPES.has(company.companyType || "")) {
    return calculateFactoryNetPositionAsOf(company.id, asOfDate);
  }
  if (company.companyType === "supplier_partner") {
    return calculateSupplierPartnerNetPositionAsOf(company.id, asOfDate);
  }
  return calculateNetPositionAsOf(company.id, asOfDate);
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
): Promise<GroupNetPositionSnapshot> {
  const companies = (await storage.getAllCompanies())
    .filter(isGroupNetPositionCompany)
    .filter((company) => allowedCompanyIds === undefined || allowedCompanyIds.has(company.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  await assertHistoricalCurrencyReady(companies, asOfDate);

  const companyPositions = await mapWithConcurrency(companies, 3, async (company) => {
    const snapshot = await calculateAuthoritativeNetPositionAsOf(company, asOfDate);
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
    excludedCompanyTypes: ["properties"],
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
      note:
        "Normal Intercompany ledger accounts are already excluded by the shared Net Position classifier, so no second group-level elimination is applied.",
    },
  };
}
