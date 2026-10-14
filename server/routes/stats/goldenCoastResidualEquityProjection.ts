import type { Express } from "express";
import { getAccountNetBalance, round2, type AccountBalance, type AccountLike } from "../../netPositionHelper";
import { logger } from "../../lib/logger";
import { loadNetProfitData } from "./netProfitDataLoad";

type LedgerRow = AccountLike & {
  subType?: string | null;
  active?: boolean | null;
  deletedAt?: unknown;
};

type DisplayAccount = {
  id?: number;
  name: string;
  code?: string;
  value: number;
  category?: string;
  balanceSide?: "Dr" | "Cr";
  currencyRevalued?: boolean;
  translationDifference?: unknown;
};

type NetProfitSection = {
  accounts?: unknown;
  total?: unknown;
  breakdown?: unknown;
  [key: string]: unknown;
};

type NetProfitResponse = {
  [key: string]: unknown;
  forUs?: NetProfitSection;
  onUs?: NetProfitSection;
  forUsTotal?: unknown;
  onUsTotal?: unknown;
  equity?: Record<string, unknown>;
  netPositionBreakdown?: Record<string, unknown>;
  currencyRevaluation?: Record<string, unknown>;
};

const ASSET_TYPES = new Set(["Asset", "Current Asset", "Fixed Asset", "Bank", "Cash"]);
const LIABILITY_TYPES = new Set(["Liability", "Loan", "Loans", "Duty Agent", "Transporter Agent"]);
const INTERNAL_SP_SUBTYPES = new Set([
  "sp_stock",
  "sp_otw_clearing",
  "sp_cost_clearing",
  "sp_pay_deduction_clearing",
  "sp_opnbal",
]);

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function accountBalance(accountId: number, balances: Map<number, AccountBalance>): AccountBalance {
  return balances.get(accountId) ?? { debit: 0, credit: 0 };
}

/**
 * Canonical Golden Coast partner capital is economically credit-normal.
 * Historical cutover rows may store the opening side as Dr, so the opening
 * magnitude is treated as the positive capital claim and subsequent ledger
 * credits increase that claim while debits reduce it.
 */
export function goldenCoastPartnerClaim(account: LedgerRow, balances: Map<number, AccountBalance>): number {
  const movement = accountBalance(account.id, balances);
  const openingClaim = Math.abs(numberValue(account.openingBalance));
  return round2(openingClaim + movement.credit - movement.debit);
}

function currentCreditNormalPayable(account: LedgerRow | null, balances: Map<number, AccountBalance>): number {
  if (!account) return 0;
  return round2(Math.max(0, -getAccountNetBalance(account, balances)));
}

function displayCategory(account: LedgerRow, side: "asset" | "liability"): string {
  if (account.subType === "sp_hadi_intercompany") return "HADI Intercompany";
  if (account.subType === "sp_goods_otw") return "Stock OTW";
  if (account.subType === "sp_prepaid" || account.subType === "sp_prepaid_expenses") return "Prepaid";
  return account.accountType || (side === "asset" ? "Asset" : "Liability");
}

function isCustomerNetPositionAccount(account: LedgerRow): boolean {
  return (
    account.accountType === "Customer" ||
    account.subType === "Accounts Receivable" ||
    (account.code || "").toUpperCase().startsWith("CUST-") ||
    (account.name || "").toLowerCase().includes("customer account")
  );
}

function addBreakdown(accounts: DisplayAccount[]): Array<{ name: string; value: number }> {
  const totals = new Map<string, number>();
  for (const account of accounts) {
    const category = account.category || "Other";
    totals.set(category, round2((totals.get(category) || 0) + numberValue(account.value)));
  }
  return [...totals.entries()]
    .filter(([, value]) => Math.abs(value) >= 0.005)
    .map(([name, value]) => ({ name, value: round2(value) }))
    .sort((a, b) => b.value - a.value);
}

function removeAccountById(
  accounts: DisplayAccount[],
  accountId: number
): { accounts: DisplayAccount[]; removed: number } {
  let removed = 0;
  const kept = accounts.filter((account) => {
    if (Number(account.id ?? 0) !== accountId) return true;
    removed = round2(removed + numberValue(account.value));
    return false;
  });
  return { accounts: kept, removed };
}

function currentTranslatedLedgerAccountIds(body: NetProfitResponse): number[] {
  const raw = body.currencyRevaluation?.currentTranslatedLedgerAccountIds;
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
}

function goldenCoastRoles(accounts: LedgerRow[]) {
  const active = accounts.filter((account) => account.active !== false && account.deletedAt == null);
  const fresh = active.find((account) => account.subType === "gc_partner_capital") ?? null;
  const hassan = active.find((account) => account.subType === "gc_owner_capital") ?? null;
  if (!fresh || !hassan) return null;

  const payableCandidates = active.filter((account) => account.subType === "sp_payable");
  const gcSalesCash =
    payableCandidates.find((account) => /gc\s*sales\s*cash/i.test(account.name || "")) ??
    (payableCandidates.length === 1 ? payableCandidates[0] : null);

  return { active, fresh, hassan, gcSalesCash };
}

/**
 * Golden Coast Net Position is an Excel-style presentation of the live ledger:
 *
 *   GC Sales Cash is shown as debit-side Cash under What We Have
 *   HADI Intercompany is hidden on this view to avoid double-counting that cash
 *   Customer balances are excluded from this Supplier Partner Net Position view
 *   Fresh Start FZ Equity = Net Position - Hassan Dakik Equity
 *
 * The canonical GC Sales Cash ledger remains a credit-normal liability for
 * posting, settlement, and every non-Net-Position accounting workflow. This
 * projection only flips its display side and never mutates ledger data.
 *
 * Fresh Start is intentionally the balance-sheet residual. No synthetic
 * "Current Period Earnings (Unclosed)" line is manufactured to force the
 * partner-capital ledgers to reconcile with the balance sheet.
 */
export function projectGoldenCoastResidualEquity(input: {
  body: NetProfitResponse;
  companyAccounts: LedgerRow[];
  accountBalances: Map<number, AccountBalance>;
}): NetProfitResponse {
  const { body, companyAccounts, accountBalances } = input;
  if (!body || typeof body !== "object" || !body.forUs || !body.onUs) return body;

  const roles = goldenCoastRoles(companyAccounts);
  if (!roles) return body;

  let forUsAccounts: DisplayAccount[] = Array.isArray(body.forUs.accounts)
    ? body.forUs.accounts.map((account: DisplayAccount) => ({ ...account }))
    : [];
  let onUsAccounts: DisplayAccount[] = Array.isArray(body.onUs.accounts)
    ? body.onUs.accounts.map((account: DisplayAccount) => ({ ...account }))
    : [];
  let forUsTotal = numberValue(body.forUs.total ?? body.forUsTotal);
  let onUsTotal = numberValue(body.onUs.total ?? body.onUsTotal);

  let gcSalesCashNetPositionValue = 0;
  const gcSalesCashPayable = currentCreditNormalPayable(roles.gcSalesCash, accountBalances);

  // Net Position-only presentation: remove GC Sales Cash from whichever generic
  // side supplied it, then show the signed inverse of its ledger net under Cash.
  // A normal credit payable therefore appears as a positive debit-side asset.
  if (roles.gcSalesCash) {
    const removedAsset = removeAccountById(forUsAccounts, roles.gcSalesCash.id);
    const removedLiability = removeAccountById(onUsAccounts, roles.gcSalesCash.id);
    forUsAccounts = removedAsset.accounts;
    onUsAccounts = removedLiability.accounts;
    forUsTotal = round2(forUsTotal - removedAsset.removed);
    onUsTotal = round2(onUsTotal - removedLiability.removed);

    gcSalesCashNetPositionValue = round2(-getAccountNetBalance(roles.gcSalesCash, accountBalances));
    if (Math.abs(gcSalesCashNetPositionValue) >= 0.005) {
      forUsTotal = round2(forUsTotal + gcSalesCashNetPositionValue);
      forUsAccounts.push({
        id: roles.gcSalesCash.id,
        name: roles.gcSalesCash.name,
        code: roles.gcSalesCash.code || "",
        value: gcSalesCashNetPositionValue,
        category: "Cash",
      });
    }
  }

  // If the generic response already supplied HADI Intercompany, remove it from
  // this presentation before adding any missing Golden Coast accounts.
  for (const account of roles.active) {
    if (account.subType !== "sp_hadi_intercompany") continue;
    const removedAsset = removeAccountById(forUsAccounts, account.id);
    const removedLiability = removeAccountById(onUsAccounts, account.id);
    forUsAccounts = removedAsset.accounts;
    onUsAccounts = removedLiability.accounts;
    forUsTotal = round2(forUsTotal - removedAsset.removed);
    onUsTotal = round2(onUsTotal - removedLiability.removed);
  }

  const existingIds = new Set<number>(
    [...forUsAccounts, ...onUsAccounts]
      .map((account) => Number(account.id ?? 0))
      .filter((id) => Number.isInteger(id) && id > 0)
  );
  for (const accountId of currentTranslatedLedgerAccountIds(body)) existingIds.add(accountId);
  if (roles.gcSalesCash) existingIds.add(roles.gcSalesCash.id);

  // The generic Supplier Partner dashboard intentionally uses a narrow account
  // set. Golden Coast adds the remaining display balance-sheet accounts such as
  // OTW, prepaid and genuine liabilities. Customers stay excluded from this Net
  // Position view. HADI Intercompany is also excluded because GC Sales Cash is
  // its Net Position cash presentation; showing both would double-count proceeds.
  for (const account of roles.active) {
    if (existingIds.has(account.id)) continue;
    if (INTERNAL_SP_SUBTYPES.has(account.subType || "")) continue;
    if (account.id === roles.fresh.id || account.id === roles.hassan.id) continue;
    if (account.subType === "sp_hadi_intercompany") continue;
    if (isCustomerNetPositionAccount(account)) continue;

    const isAsset = ASSET_TYPES.has(account.accountType || "");
    const isLiability = LIABILITY_TYPES.has(account.accountType || "");
    if (!isAsset && !isLiability) continue;

    const net = round2(getAccountNetBalance(account, accountBalances));
    if (Math.abs(net) < 0.005) continue;

    if (isLiability) {
      if (net < 0) {
        const value = round2(Math.abs(net));
        onUsTotal = round2(onUsTotal + value);
        onUsAccounts.push({
          id: account.id,
          name: account.name,
          code: account.code || "",
          value,
          category: displayCategory(account, "liability"),
        });
      } else {
        const value = round2(net);
        forUsTotal = round2(forUsTotal + value);
        forUsAccounts.push({
          id: account.id,
          name: account.name,
          code: account.code || "",
          value,
          category: `${displayCategory(account, "asset")} Deposit`,
        });
      }
      existingIds.add(account.id);
      continue;
    }

    if (net > 0) {
      const value = round2(net);
      forUsTotal = round2(forUsTotal + value);
      forUsAccounts.push({
        id: account.id,
        name: account.name,
        code: account.code || "",
        value,
        category: displayCategory(account, "asset"),
      });
    } else {
      const value = round2(Math.abs(net));
      onUsTotal = round2(onUsTotal + value);
      onUsAccounts.push({
        id: account.id,
        name: account.name,
        code: account.code || "",
        value,
        category: `${displayCategory(account, "liability")} Overdraft`,
      });
    }
    existingIds.add(account.id);
  }

  forUsTotal = round2(forUsTotal);
  onUsTotal = round2(onUsTotal);
  const netPosition = round2(forUsTotal - onUsTotal);

  const freshStartLedgerClaim = goldenCoastPartnerClaim(roles.fresh, accountBalances);
  const hassanClaim = goldenCoastPartnerClaim(roles.hassan, accountBalances);
  const freshStartResidual = round2(netPosition - hassanClaim);
  const partnerCapitalTotal = round2(freshStartResidual + hassanClaim);

  const equityAccounts: DisplayAccount[] = [
    {
      id: roles.fresh.id,
      name: roles.fresh.name,
      code: roles.fresh.code || "",
      value: round2(Math.abs(freshStartResidual)),
      category: "Partner Capital / Equity",
      balanceSide: freshStartResidual >= 0 ? "Cr" : "Dr",
    },
    {
      id: roles.hassan.id,
      name: roles.hassan.name,
      code: roles.hassan.code || "",
      value: round2(Math.abs(hassanClaim)),
      category: "Partner Capital / Equity",
      balanceSide: hassanClaim >= 0 ? "Cr" : "Dr",
    },
  ];

  const equity = {
    ...(body.equity || {}),
    total: netPosition,
    accounts: equityAccounts,
    includedInNetPosition: false,
    balanceSheetIdentity: "assets_minus_liabilities_equals_equity",
    residualFormula: "net_position_minus_hassan",
    freshStartResidual,
    freshStartClaim: freshStartResidual,
    freshStartLedgerClaim,
    freshStartTotalEntitlement: freshStartResidual,
    hassanClaim,
    partnerCapitalTotal,
    unclosedEarnings: 0,
    currencyTranslationAdjustment: 0,
    gcSalesCashPayable,
    gcSalesCashNetPositionValue,
    legacyOpeningPayableReclassification: 0,
  };

  const forUsBreakdown = addBreakdown(forUsAccounts);
  const onUsBreakdown = addBreakdown(onUsAccounts);
  const netPositionBreakdown = {
    ...(body.netPositionBreakdown || {}),
    assets: { total: forUsTotal, breakdown: forUsBreakdown },
    liabilities: { total: onUsTotal, breakdown: onUsBreakdown },
    equity,
    netPosition,
  };

  return {
    ...body,
    forUs: {
      ...body.forUs,
      total: forUsTotal,
      breakdown: forUsBreakdown,
      accounts: forUsAccounts,
    },
    onUs: {
      ...body.onUs,
      total: onUsTotal,
      breakdown: onUsBreakdown,
      accounts: onUsAccounts,
    },
    equity,
    netPosition,
    netWorth: netPosition,
    netPositionLabel: netPosition >= 0 ? "Net Assets" : "Net Liabilities",
    netPositionBreakdown,
    forUsTotal,
    onUsTotal,
  };
}

/**
 * Installs a response projection immediately before the existing Net Profit
 * route. The accounting engine stays unchanged for every other company type.
 */
export function registerGoldenCoastResidualEquityProjection(app: Express): void {
  app.use("/api/stats/net-profit", async (req, res, next) => {
    if (req.method !== "GET") return next();
    const companyId = req.session.currentCompanyId;
    if (!companyId) return next();

    try {
      const toDate = req.query.toDate ? String(req.query.toDate) : null;
      const reportData = await loadNetProfitData(companyId, toDate);
      if (reportData.companyRecord?.companyType !== "supplier_partner") return next();
      if (!goldenCoastRoles(reportData.companyAccounts as LedgerRow[])) return next();

      const originalJson = res.json.bind(res);
      res.json = ((body: NetProfitResponse) =>
        originalJson(
          projectGoldenCoastResidualEquity({
            body,
            companyAccounts: reportData.companyAccounts as LedgerRow[],
            accountBalances: reportData.accountBalances,
          })
        )) as typeof res.json;
    } catch (error) {
      logger.warn("Golden Coast balance-sheet projection unavailable; using base Net Position response", { error });
    }

    return next();
  });
}
