// Canonical, company-isolated supplier balance calculation.
//
// Supplier rows are company-owned through suppliers.company_id. A supplier may
// be read or posted only from its owning company. The legacy parent-company
// setting is retained solely for historical opening-balance ownership when no
// active company context is available; it must never make an explicitly
// unlinked company behave like a child company.

import type Decimal from "decimal.js";
import { toMoney } from "../../lib/money";
import { loadPartyOpeningSides, partyOpeningSide, type OpeningSide } from "./partyOpeningSide";
import { storage } from "../../storage";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { getVoucherEntriesBySupplierBatched } from "../performance/supplierVoucherEntryBatcher";

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
  /** Signed balance, Cr positive (we owe the supplier): opening + Σ(credit − debit). */
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
  /** Net balance in each transaction currency: { currency: { debit, credit, net } }. */
  balancesByCurrency: Record<string, { debit: number; credit: number; net: number }>;
  /** Sum of base credits minus base debits, including the owned opening balance. */
  historicalBaseBalance: number;
}

export interface SupplierBalanceContextOptions {
  /**
   * Account pickers can still provide company-scoped activity when the legacy
   * supplier opening-balance owner is ambiguous. In that narrow read-only
   * context, treat the unowned legacy opening balance as zero instead of
   * making unrelated ledger accounts fail to load.
   */
  allowUnconfiguredLegacyScope?: boolean;
  /** Count only vouchers dated (COALESCE(effective_date, voucher_date)) on or before this day. */
  endDate?: string;
  /** Lines before this day are carried into periodOpeningBalance. */
  startDate?: string;
}

function emptySupplierBalance(): SupplierBalanceContextResult {
  return {
    balance: 0,
    openingBalance: 0,
    openingBalanceSide: "Cr",
    periodOpeningBalance: 0,
    hasActivity: false,
    entries: [],
    balancesByCurrency: {},
    historicalBaseBalance: 0,
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
 * Canonical supplier balance for a viewing company.
 *
 * When suppliers.company_id is present, a mismatched company receives an empty
 * result even if historical cross-company voucher references still exist. This
 * prevents legacy references from making a foreign supplier visible.
 *
 * Every posted line counts as credit − debit: a line carrying both a debit and
 * a credit is netted, not dropped. The opening follows
 * suppliers.opening_balance_side (null → Cr).
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
  if (companyId && supplier.companyId && supplier.companyId !== companyId) {
    return emptySupplierBalance();
  }

  let ownsOpeningBalance: boolean;
  if (supplier.companyId) {
    ownsOpeningBalance = !companyId || supplier.companyId === companyId;
  } else {
    try {
      ownsOpeningBalance = await isParentCompanyContext(companyId);
    } catch (error) {
      if (!(options.allowUnconfiguredLegacyScope && error instanceof ParentCompanyNotConfiguredError)) {
        throw error;
      }
      ownsOpeningBalance = false;
    }
  }
  const openingAmount = ownsOpeningBalance ? toMoney(supplier.openingBalance) : toMoney(0);
  let openingBalanceSide: OpeningSide = "Cr";
  if (supplier.openingBalanceSide !== undefined) {
    openingBalanceSide = partyOpeningSide(supplier.openingBalanceSide);
  } else if (!openingAmount.isZero()) {
    openingBalanceSide = (await loadPartyOpeningSides("suppliers", [supplier.id])).get(supplier.id) ?? "Cr";
  }
  // Cr positive: a Dr opening (the supplier owes us) is negative.
  const signedOpening = openingBalanceSide === "Dr" ? openingAmount.negated() : openingAmount;

  const allEntries = await getVoucherEntriesBySupplierBatched(supplier.id, companyId || undefined);
  const entries = options.endDate
    ? allEntries.filter((entry) => {
        const day = isoDay(entry.voucherDate);
        return day === null || day <= options.endDate!;
      })
    : allEntries;

  let balanceD = signedOpening;
  let periodOpeningD = signedOpening;
  let historicalBaseD = signedOpening;
  const byCurrency: Record<string, { debit: Decimal; credit: Decimal }> = {};
  for (const entry of entries) {
    const net = toMoney(entry.creditAmount).minus(toMoney(entry.debitAmount));
    balanceD = balanceD.plus(net);
    if (options.startDate) {
      const day = isoDay(entry.voucherDate);
      if (day !== null && day < options.startDate) periodOpeningD = periodOpeningD.plus(net);
    }
    historicalBaseD = historicalBaseD
      .plus(toMoney(entry.baseCreditAmount ?? entry.creditAmount))
      .minus(toMoney(entry.baseDebitAmount ?? entry.debitAmount));

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

  const openingBalance = openingAmount.toNumber();
  return {
    balance: balanceD.toNumber(),
    openingBalance,
    openingBalanceSide,
    periodOpeningBalance: periodOpeningD.toNumber(),
    hasActivity: entries.length > 0 || openingBalance !== 0,
    entries,
    balancesByCurrency,
    historicalBaseBalance: historicalBaseD.toNumber(),
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
