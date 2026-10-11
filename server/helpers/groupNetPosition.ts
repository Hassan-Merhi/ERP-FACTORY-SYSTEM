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
import { loadCompanyIntercompanyAccounts, type IntercompanyAccount } from "./groupIntercompany";

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

const EXCLUDED_COMPANY_TYPES = new Set(["factory", "factory_v2", "supplier_partner"]);
const EXCLUDED_COMPANY_TYPE_LIST = ["factory", "factory_v2", "supplier_partner"];
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

function accountValue(account: unknown): number {
  return round2(Number(asRecord(account).value ?? 0) || 0);
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

interface ErpNetPositionWithIntercompany extends NetPositionSnapshot {
  /** Signed values (What We Have positive) of the intercompany accounts removed from the lines, by id. */
  removedIntercompany: Map<number, number>;
}

async function calculateErpNetPosition(
  companyId: number,
  asOfDate: string,
  useCurrentSnapshot: boolean,
  intercompanyIds: ReadonlySet<number>
): Promise<ErpNetPositionWithIntercompany> {
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
  const rawForUsTotal = round2(Number(body.forUsTotal ?? forUs.total ?? 0) || 0);
  const rawOnUsTotal = round2(Number(body.onUsTotal ?? onUs.total ?? 0) || 0);
  const rawForUsAccounts = Array.isArray(forUs.accounts) ? forUs.accounts : [];
  const rawOnUsAccounts = Array.isArray(onUs.accounts) ? onUs.accounts : [];

  // Intercompany accounts are taken out of the company's lines by id and
  // eliminated in pairs at group level (owner decision 1); nothing is removed
  // by name or code.
  const isIntercompany = (account: unknown) => {
    const row = asRecord(account);
    const id = Number(row.id);
    return row.bankAccountId == null && Number.isInteger(id) && intercompanyIds.has(id);
  };
  const removedIntercompany = new Map<number, number>();
  for (const account of rawForUsAccounts.filter(isIntercompany)) {
    const id = Number(asRecord(account).id);
    removedIntercompany.set(id, round2((removedIntercompany.get(id) ?? 0) + accountValue(account)));
  }
  for (const account of rawOnUsAccounts.filter(isIntercompany)) {
    const id = Number(asRecord(account).id);
    removedIntercompany.set(id, round2((removedIntercompany.get(id) ?? 0) - accountValue(account)));
  }
  const excludedForUsTotal = round2(
    rawForUsAccounts.filter(isIntercompany).reduce((sum, account) => sum + accountValue(account), 0)
  );
  const excludedOnUsTotal = round2(
    rawOnUsAccounts.filter(isIntercompany).reduce((sum, account) => sum + accountValue(account), 0)
  );
  const forUsAccounts = rawForUsAccounts.filter((account) => !isIntercompany(account));
  const onUsAccounts = rawOnUsAccounts.filter((account) => !isIntercompany(account));
  const forUsTotal = round2(rawForUsTotal - excludedForUsTotal);
  const onUsTotal = round2(rawOnUsTotal - excludedOnUsTotal);
  const netPosition = round2(forUsTotal - onUsTotal);

  return {
    forUsTotal,
    onUsTotal,
    netPosition,
    netPositionLabel: netPosition >= 0 ? "We have more than we owe" : "We owe more than we have",
    forUsLines: forUsAccounts.map((account) => toLineItem(account, "forUs")),
    onUsLines: onUsAccounts.map((account) => toLineItem(account, "onUs")),
    removedIntercompany,
  };
}

async function assertHistoricalCurrencyReady(
  companies: CompanyRecord[],
  asOfDate: string,
  allowedCompanyIds?: ReadonlySet<number>
): Promise<void> {
  await mapWithConcurrency(companies, 2, async (company) => {
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
  const allCompanies = await storage.getAllCompanies();
  const companies = allCompanies
    .filter(isGroupNetPositionCompany)
    .filter((company) => allowedCompanyIds === undefined || allowedCompanyIds.has(company.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  await assertHistoricalCurrencyReady(companies, asOfDate, allowedCompanyIds);

  // Each ERP net-position calculation already runs several DB reads in parallel.
  // Running multiple companies concurrently can exceed the production pool and
  // create queue pressure. Serialize company snapshots; the group-level cache
  // keeps normal navigation fast while explicit Refresh still gets fresh data.
  const companyPositions = await mapWithConcurrency(companies, 1, async (company) => {
    const { snapshot, intercompanyAccounts } = await runWithGroupCompanyScope(
      company.id,
      allowedCompanyIds,
      async () => {
        const accounts = await loadCompanyIntercompanyAccounts(company, allCompanies, asOfDate);
        const ids = new Set(accounts.map((account) => account.accountId));
        return {
          snapshot: await calculateErpNetPosition(company.id, asOfDate, useCurrentSnapshot, ids),
          intercompanyAccounts: accounts,
        };
      }
    );

    // Group Net Position is intentionally the aggregate ERP balance sheet:
    // What We Have minus What We Owe. Supplier Partner/equity adjustments are
    // outside this report; intercompany balances are eliminated in pairs below.
    const sideNetPosition = round2(snapshot.forUsTotal - snapshot.onUsTotal);

    // An account shown in the company's lines carries the value shown there;
    // one the classifier leaves out (typed Intercompany) its ledger balance.
    const intercompany = intercompanyAccounts.map((account) => ({
      ...account,
      value: snapshot.removedIntercompany.get(account.accountId) ?? round2(Number(account.balance)),
    }));

    return {
      position: {
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
      } satisfies GroupNetPositionCompany,
      intercompany,
    };
  });

  const positions = companyPositions.map((entry) => entry.position);
  const { pairs, differences, eliminated } = pairIntercompanyBalances(
    companyPositions.flatMap((entry) => entry.intercompany),
    companies
  );
  const differenceForUs = round2(
    differences.filter((line) => line.side === "forUs").reduce((sum, line) => sum + line.value, 0)
  );
  const differenceOnUs = round2(
    differences.filter((line) => line.side === "onUs").reduce((sum, line) => sum + line.value, 0)
  );

  const forUsTotal = round2(positions.reduce((sum, company) => sum + company.forUsTotal, 0) + differenceForUs);
  const onUsTotal = round2(positions.reduce((sum, company) => sum + company.onUsTotal, 0) + differenceOnUs);
  const sideNetPosition = round2(forUsTotal - onUsTotal);
  const netAdjustments = 0;

  return {
    asOfDate,
    companyCount: positions.length,
    excludedCompanyTypes: [...EXCLUDED_COMPANY_TYPE_LIST],
    companies: positions,
    totals: {
      forUsTotal,
      onUsTotal,
      sideNetPosition,
      netAdjustments,
      netPosition: sideNetPosition,
    },
    intercompany: {
      mode: "paired-elimination",
      additionalElimination: eliminated,
      pairs,
      differences,
      note:
        "Intercompany balances are eliminated per company pair (inter-company transfers, intercompany POS " +
        "configuration, parent credit accounts and accounts typed Intercompany): each company's net balance with " +
        "the other is eliminated against the other's net balance with it; any unmatched or mismatched amount is " +
        "shown as an Intercompany difference line for that pair and included in the group totals.",
    },
  };
}

interface IntercompanyValue extends IntercompanyAccount {
  /** Signed, What We Have positive. */
  value: number;
}

/**
 * Pairs the intercompany balances of the group companies (owner decision 1),
 * per company pair (wave 17 A). Each account is keyed by its company and the
 * group companies its recorded links name: an account of A linked with B is in
 * pair {A, B}. Within a pair, A's net balance with B (all of A's accounts in
 * the pair, receivable positive) is eliminated against B's net balance with A:
 * the matched part is min(|A|, |B|) when the two are on opposite sides, and
 * the pair's difference A + B is an "Intercompany difference" line. Before,
 * companies linked by any account formed one set whose receivables were
 * eliminated against its payables, so in a chain A–B–C–D a receivable of B
 * from C could be "matched" against a payable of D to A, and each pair's own
 * mismatch was hidden in the set total.
 *
 * An account whose links name several group companies (one account used with
 * B and C) cannot be split by pair: it forms its own set with all of them and
 * is matched only against accounts with the same set. An account with no
 * counterpart in this report is unpaired: its whole balance is a difference.
 */
export function pairIntercompanyBalances(
  accounts: readonly IntercompanyValue[],
  companies: ReadonlyArray<Pick<CompanyRecord, "id" | "name">>
): { pairs: GroupIntercompanyPair[]; differences: NetPositionLineItem[]; eliminated: number } {
  const inGroup = new Set(companies.map((company) => company.id));
  const nameOf = (id: number) => companies.find((company) => company.id === id)?.name ?? `Company ${id}`;

  const sets = new Map<string, { companyIds: number[]; members: IntercompanyValue[] }>();
  const unpaired: IntercompanyValue[] = [];
  for (const account of accounts) {
    const counterparts = account.counterpartyCompanyIds.filter((id) => inGroup.has(id) && id !== account.companyId);
    if (counterparts.length === 0) {
      unpaired.push(account);
      continue;
    }
    const companyIds = [...new Set([account.companyId, ...counterparts])].sort((a, b) => a - b);
    const key = companyIds.join(":");
    const set = sets.get(key) ?? { companyIds, members: [] };
    set.members.push(account);
    sets.set(key, set);
  }

  const pairs: GroupIntercompanyPair[] = [];
  const differences: NetPositionLineItem[] = [];
  let eliminated = 0;
  const summarize = (companyIds: number[], members: IntercompanyValue[], unpairedAccount: boolean, label: string) => {
    // Each company's net balance with the others of the pair, receivable positive.
    const byCompany = companyIds.map((companyId) => ({
      companyId,
      companyName: nameOf(companyId),
      net: round2(members.filter((m) => m.companyId === companyId).reduce((sum, m) => sum + m.value, 0)),
    }));
    const receivables = round2(byCompany.filter((c) => c.net > 0).reduce((sum, c) => sum + c.net, 0));
    const payables = round2(byCompany.filter((c) => c.net < 0).reduce((sum, c) => sum - c.net, 0));
    const matched = unpairedAccount ? 0 : round2(Math.min(receivables, payables));
    const difference = round2(receivables - payables);
    eliminated = round2(eliminated + matched);
    pairs.push({
      companyIds,
      companyNames: companyIds.map(nameOf),
      accounts: members.map((m) => ({
        companyId: m.companyId,
        accountId: m.accountId,
        accountName: m.accountName,
        balance: m.value,
      })),
      byCompany,
      receivables,
      payables,
      eliminated: matched,
      difference,
      status: unpairedAccount ? "unpaired" : Math.abs(difference) < 0.005 ? "matched" : "mismatched",
    });
    if (Math.abs(difference) >= 0.005) {
      differences.push({
        label,
        value: Math.abs(difference),
        category: INTERCOMPANY_DIFFERENCE_LABEL,
        side: difference > 0 ? "forUs" : "onUs",
      });
    }
  };

  for (const { companyIds, members } of sets.values()) {
    summarize(companyIds, members, false, `${INTERCOMPANY_DIFFERENCE_LABEL}: ${companyIds.map(nameOf).join(" ↔ ")}`);
  }
  for (const account of unpaired) {
    const outside = account.counterpartyCompanyIds.filter((id) => !inGroup.has(id));
    const reason =
      outside.length > 0
        ? `counterpart company ${outside.join(", ")} is not in this report`
        : "no counterpart recorded in the group";
    summarize(
      [account.companyId],
      [account],
      true,
      `${INTERCOMPANY_DIFFERENCE_LABEL}: ${nameOf(account.companyId)} — ${account.accountName} (${reason})`
    );
  }
  return { pairs, differences, eliminated };
}
