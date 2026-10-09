// Canonical, company-isolated supplier balance calculation.
//
// Supplier rows are company-owned through suppliers.company_id (NOT NULL).
// Balances come from the one balance engine (wave 13): the opening belongs to
// the supplier's company and each posted line to its voucher's company. The
// legacy parent-company setting below is kept for the readers that still use
// it (parent fallback pickers, raw-material reconciliation); it no longer
// decides any supplier balance.

import type Decimal from "decimal.js";
import { toMoney } from "../../lib/money";
import { partyOpeningSide, type OpeningSide } from "./partyOpeningSide";
import { storage } from "../../storage";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import {
  getSupplierEngineBalanceBatched,
  getVoucherEntriesBySupplierBatched,
} from "../performance/supplierVoucherEntryBatcher";

let parentCompanyResolution: Promise<number> | null = null;

export class ParentCompanyNotConfiguredError extends Error {
  constructor() {
    super(
      "Parent company is not configured (system setting 'parentCompanyId' is unset) and there is more than one " +
        "ERP company, so legacy supplier opening balances cannot be safely isolated. An Admin must set the parent " +
        "company under Company Settings before viewing supplier balances."
    );
    this.name = "ParentCompanyNotConfiguredError";
  }
}

/**
 * Resolves the accounting parent for a company-scoped request.
 *
 * When a companyId is supplied, companies.parent_company_id is authoritative:
 * an explicit parent link returns that parent; no link means the company is
 * standalone/root and therefore resolves to itself. The legacy global setting
 * is consulted only by callers that do not have a company context, and never
 * guesses via lowest company ID. Concurrent callers share one in-flight
 * resolution to avoid repeated configuration reads.
 */
export async function resolveParentCompanyId(companyId?: number | null): Promise<number> {
  if (companyId) {
    const currentCompany = await storage.getCompanyById(companyId);
    if (currentCompany?.parentCompanyId) return currentCompany.parentCompanyId;
    return companyId;
  }

  if (parentCompanyResolution) return parentCompanyResolution;

  const resolution = (async () => {
    const configured = await storage.getParentCompanyId();
    if (configured) return configured;

    const allCompanies = await storage.getAllCompanies();
    const erpCompanies = allCompanies.filter((c) => !c.companyType || c.companyType === "erp");
    if (erpCompanies.length === 1) return erpCompanies[0].id;

    throw new ParentCompanyNotConfiguredError();
  })();

  parentCompanyResolution = resolution;
  try {
    return await resolution;
  } finally {
    if (parentCompanyResolution === resolution) parentCompanyResolution = null;
  }
}

export async function isParentCompanyContext(companyId?: number | null): Promise<boolean> {
  if (!companyId) return true;

  const currentCompany = await storage.getCompanyById(companyId);
  if (currentCompany?.parentCompanyId) return false;

  // A company explicitly referenced by a child is unquestionably a parent.
  const linkedChild = (await storage.getAllCompanies()).some((company) => company.parentCompanyId === companyId);
  if (linkedChild) return true;

  // For a standalone company, the old global setting may still identify the
  // owner of historical supplier opening balances, but it does not create an
  // intercompany relationship for current transactions.
  const legacyParentCompanyId = await storage.getParentCompanyId();
  return legacyParentCompanyId === companyId;
}

/**
 * Whether a supplier row may be shown to the company currently being viewed.
 *
 * Supplier rows are company-owned through suppliers.company_id, but the account
 * pickers load every supplier and historically relied on the child-company
 * "no activity here" filter to hide other tenants' rows. That is not a tenant
 * boundary: a company that resolves to itself (a standalone or root company)
 * skips that filter and would otherwise see every other tenant's supplier names
 * and codes, and in the voucher sidebar their opening balances too.
 *
 * Rows predating the company-scope migration have a null company_id and are not
 * owned by any single tenant, so they stay visible; ownership of their opening
 * balance is decided separately by isParentCompanyContext.
 */
export function isSupplierVisibleToCompany(
  supplier: { companyId?: number | null },
  companyId?: number | null
): boolean {
  if (!supplier.companyId) return true;
  if (!companyId) return true;
  return supplier.companyId === companyId;
}

export interface SupplierBalanceContextResult {
  /** Signed balance, Cr positive (we owe the supplier): the engine's closing, negated. */
  balance: number;
  /** Owned opening amount (unsigned); its side is openingBalanceSide. */
  openingBalance: number;
  /** suppliers.opening_balance_side, null → Cr. */
  openingBalanceSide: OpeningSide;
  /**
   * Cr-positive balance carried into the period: the opening plus every line
   * before options.startDate. Equals the signed opening without a start date.
   */
  periodOpeningBalance: number;
  hasActivity: boolean;
  entries: Array<{
    creditAmount?: string | null;
    debitAmount?: string | null;
    transactionCurrency?: string | null;
    transactionDebitAmount?: string | null;
    transactionCreditAmount?: string | null;
    baseDebitAmount?: string | null;
    baseCreditAmount?: string | null;
  }>;
  /** Net balance in each transaction currency: { currency: { debit, credit, net } }, of the same lines. */
  balancesByCurrency: Record<string, { debit: number; credit: number; net: number }>;
  /** Sum of base credits minus base debits, including the owned opening balance. */
  historicalBaseBalance: number;
  /** Always "ledger": the figures are the balance engine's (wave 13). */
  balanceBasis: "ledger";
  /** The company whose vouchers were read (the voucher company). */
  voucherCompanyId: number | null;
}

export interface SupplierBalanceContextOptions {
  /**
   * Kept for callers written before wave 13; suppliers.company_id is NOT NULL,
   * so an opening always has an owner and this no longer changes anything.
   */
  allowUnconfiguredLegacyScope?: boolean;
  /** Count only vouchers dated (COALESCE(effective_date, voucher_date)) on or before this day. */
  endDate?: string;
  /** Lines before this day are carried into periodOpeningBalance. */
  startDate?: string;
}

function emptySupplierBalance(companyId: number | null): SupplierBalanceContextResult {
  return {
    balance: 0,
    openingBalance: 0,
    openingBalanceSide: "Cr",
    periodOpeningBalance: 0,
    hasActivity: false,
    entries: [],
    balancesByCurrency: {},
    historicalBaseBalance: 0,
    balanceBasis: "ledger",
    voucherCompanyId: companyId,
  };
}

/** YYYY-MM-DD of a pg DATE value (node-postgres parses DATE as local midnight). */
function isoDay(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${month}-${day}`;
  }
  if (typeof value === "string" && value.length >= 10) return value.slice(0, 10);
  return null;
}

/**
 * Supplier balance for a viewing company, from the one balance engine
 * (accounting audit wave 13, A1).
 *
 *   - The balance is the engine's (kind "supplier"): the supplier's opening
 *     with its side, counted only in the supplier's own company, plus the
 *     lines the engine attributes to it in the voucher company. A
 *     supplier-tagged line on a ledger account, bank or fixed asset is that
 *     account's line and is not counted here (it used to be counted twice:
 *     once on the account, once on the supplier).
 *   - Vouchers count from COALESCE(effective_date, voucher_date); a line
 *     carrying both a debit and a credit is netted.
 *   - The company filter is always applied. A subsidiary that posted to a
 *     parent's shared supplier sees the lines it posted (owner decision 2:
 *     the payable counts in the posting company), never the parent's opening
 *     or the parent's lines.
 *
 * `entries` and `balancesByCurrency` are the same owned lines, so the
 * per-currency view always foots to the balance's lines.
 */
export async function getSupplierBalanceForContext(
  supplier: {
    id: number;
    companyId?: number | null;
    openingBalance?: string | null;
    openingBalanceSide?: string | null;
  },
  companyId?: number | null,
  options: SupplierBalanceContextOptions = {}
): Promise<SupplierBalanceContextResult> {
  const voucherCompanyId = companyId || supplier.companyId || null;
  if (!voucherCompanyId) return emptySupplierBalance(null);

  const [party, allEntries] = await Promise.all([
    getSupplierEngineBalanceBatched(supplier.id, voucherCompanyId, {
      asOf: options.endDate ?? null,
      from: options.startDate ?? null,
    }),
    getVoucherEntriesBySupplierBatched(supplier.id, voucherCompanyId),
  ]);
  const entries = options.endDate
    ? allEntries.filter((entry) => {
        const day = isoDay(entry.voucherDate);
        return day === null || day <= options.endDate!;
      })
    : allEntries;

  // Engine amounts are debit positive; a supplier balance is Cr positive.
  const masterOpening = toMoney(party?.masterOpening);
  let openingBalanceSide: OpeningSide;
  if (masterOpening.isNegative()) openingBalanceSide = "Cr";
  else if (masterOpening.greaterThan(0)) openingBalanceSide = "Dr";
  else openingBalanceSide = partyOpeningSide(supplier.openingBalanceSide ?? null);

  const byCurrency: Record<string, { debit: Decimal; credit: Decimal }> = {};
  for (const entry of entries) {
    const ccy: string = (entry.transactionCurrency as string | null) || "USD";
    const bucket = byCurrency[ccy] ?? { debit: toMoney(0), credit: toMoney(0) };
    byCurrency[ccy] = {
      debit: bucket.debit.plus(toMoney(entry.transactionDebitAmount ?? entry.debitAmount)),
      credit: bucket.credit.plus(toMoney(entry.transactionCreditAmount ?? entry.creditAmount)),
    };
  }
  const balancesByCurrency: Record<string, { debit: number; credit: number; net: number }> = {};
  for (const [ccy, { debit, credit }] of Object.entries(byCurrency)) {
    balancesByCurrency[ccy] = {
      debit: debit.toNumber(),
      credit: credit.toNumber(),
      net: credit.minus(debit).toNumber(),
    };
  }

  const openingBalance = masterOpening.abs().toNumber();
  return {
    balance: toMoney(party?.closing).negated().toNumber(),
    openingBalance,
    openingBalanceSide,
    periodOpeningBalance: toMoney(party?.opening).negated().toNumber(),
    hasActivity: entries.length > 0 || openingBalance !== 0,
    entries,
    balancesByCurrency,
    historicalBaseBalance: toMoney(party?.historicalBaseClosing).negated().toNumber(),
    balanceBasis: "ledger",
    voucherCompanyId,
  };
}

/**
 * Authorizes an arbitrary companyId query parameter against the authenticated
 * user's actual company access. Supplier master routes should still prefer the
 * active session company and should not use this helper to broaden visibility.
 */
export async function authorizeCompanyIdParam(
  req: { session: { currentCompanyId?: number; userId?: string } },
  requestedCompanyId?: number | null
): Promise<number | null> {
  if (!requestedCompanyId) return req.session.currentCompanyId ?? null;
  if (requestedCompanyId === req.session.currentCompanyId) return requestedCompanyId;

  const userId = req.session.userId;
  if (!userId) return null;
  const accessibleCompanyIds = await getAccessibleCompanyIds(userId);
  return accessibleCompanyIds.has(requestedCompanyId) ? requestedCompanyId : null;
}
