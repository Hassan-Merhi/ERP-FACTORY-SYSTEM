/**
 * Phase 2: READ-ONLY company-scoped four-category USD monetary valuation.
 *
 * This engine NEVER updates vouchers, currency openings, journal amounts or FX
 * gain/loss accounts. It aggregates posted original-currency entries using the
 * ledger balance engine's customer/ledger/bank attribution rules and returns
 * separate reporting translations. Phase 4+ consumers must NOT append these
 * values to the book balances; they replace only their uniquely keyed rows.
 */
import Decimal from "decimal.js";
import { db, type DbTransaction } from "../../db";
import { sql } from "drizzle-orm";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { datedMonetaryRateTx, fxDay, MonetaryFxError } from "./monetaryFxRates";
import { companyBusinessDate } from "./companyBusinessDate";
import { openingSideOf } from "./balances/openingSide";
import { customerLinksBody, noNonCustomerTarget } from "./balances/partyLineRules";
import {
  canonicalMonetaryCurrency, monetaryFxEligibility, translateMonetaryFxBalance,
  type MonetaryFxCategory, type MonetaryFxEligibility, type MonetaryFxEligibilityOptions, type MonetaryFxKind, type MonetaryFxRate,
  type MonetaryFxRateMap,
} from "./monetaryFxValuationCore";

type MonetaryMasterRow = {
  kind: MonetaryFxKind;
  id: number;
  code: string | null;
  name: string;
  account_type: string | null;
  sub_type: string | null;
  deleted: boolean;
  linked_ledger_id: number | null;
  opening_balance: string | null;
  opening_balance_side: string | null;
  opening_balance_native_amount: string | null;
  opening_balance_currency: string | null;
  opening_balance_base_amount: string | null;
};

type NativeMovementRow = {
  kind: MonetaryFxKind;
  target_id: number;
  entry_currency: string;
  native_net: string;
  historical_base_net: string;
  /** Posted book USD (debit_amount - credit_amount), the balance engine's `closing` basis. */
  posted_net: string;
  unresolved_count: string;
};

export interface MonetaryFxValuationRow {
  accountKey: string;
  accountKind: MonetaryFxKind;
  id: number;
  linkedLedgerId: number | null;
  code: string;
  name: string;
  category: MonetaryFxCategory | "needs_review";
  eligibility: MonetaryFxEligibility;
  deleted: boolean;
  nativeBalancesByCurrency: Record<string, string>;
  /** Signed book USD on the historical base-amount basis (base_debit/base_credit, 6 dp). */
  historicalBaseUsd: string | null;
  /**
   * Signed book USD on the posted-amount basis (debit_amount/credit_amount, 2 dp
   * per line): the balance engine's `closing`, which the Accounts list, the
   * Customers list and the Factory Net Position present. Always known; it is
   * the figure a consumer must match before replacing a row.
   */
  bookClosingUsd: string;
  currentTranslatedUsd: string | null;
  translationDifferenceUsd: string | null;
  unresolvedCurrencies: string[];
  unresolvedEntryCount: number;
  unresolvedOpening: boolean;
  openingBookMismatch: boolean;
  provisional: boolean;
}

export interface MonetaryFxValuationResult {
  companyId: number;
  businessDate: string;
  valuationMode: "CURRENT";
  baseCurrency: string;
  bookBalancesModified: false;
  fxVouchersPosted: false;
  accounts: MonetaryFxValuationRow[];
  rates: MonetaryFxRate[];
  /** Saved-rate conflicts do not suppress other currency translations. */
  rateErrorsByCurrency: Record<string, string>;
  eligibleAccountCount: number;
  unresolvedAccountCount: number;
  needsReviewCount: number;
  excludedLedgerAndPartyCounts: {
    excludedMasters: number;
    customerLinkedLedgerMasters: number;
  };
}

/**
 * Master openings. Mirrors ledgerBalanceEngine.loadOpenings:
 * - every customer has ONE own opening;
 * - the ledger account linked to a customer has NO independent row;
 * - the bank has its own opening (bank-only postings separately attributed).
 * Do not filter soft-deleted master rows here: the balance engine does not
 * drop their still-posted financial history. Expose their deleted state.
 */
async function loadMonetaryMasters(tx: DbTransaction, companyId: number): Promise<MonetaryMasterRow[]> {
  const result = await tx.execute(readSql(`
    WITH customer_links AS (${customerLinksBody("$1")})
    SELECT 'ledger'::text AS kind, la.id, la.code, la.name, la.account_type,
           la.sub_type, (la.deleted_at IS NOT NULL) AS deleted,
           NULL::integer AS linked_ledger_id,
           la.opening_balance::text, la.opening_balance_side::text,
           la.opening_balance_native_amount::text,
           la.opening_balance_currency::text,
           la.opening_balance_base_amount::text
      FROM ledger_accounts la
     WHERE la.company_id = $1
       AND NOT EXISTS (SELECT 1 FROM customer_links cl WHERE cl.ledger_account_id = la.id)
    UNION ALL
    SELECT 'bank', b.id, b.code, b.name, 'Bank', NULL,
           (b.deleted_at IS NOT NULL), b.linked_ledger_id,
           b.opening_balance::text, b.opening_balance_side::text,
           b.opening_balance_native_amount::text,
           b.opening_balance_currency::text,
           b.opening_balance_base_amount::text
      FROM bank_accounts b WHERE b.company_id = $1
    UNION ALL
    SELECT 'customer', c.id, c.code, c.legal_name, 'Customer', NULL,
           (c.deleted_at IS NOT NULL), cl.ledger_account_id,
           c.opening_balance::text, c.opening_balance_side::text,
           c.opening_balance_native_amount::text,
           c.opening_balance_currency::text,
           c.opening_balance_base_amount::text
      FROM customers c
      LEFT JOIN customer_links cl ON cl.customer_id = c.id
     WHERE c.company_id = $1
  `, companyId));
  return resultRows<MonetaryMasterRow & Record<string, unknown>>(result);
}

/**
 * Mirror ledgerBalanceEngine.loadLines attribution. The native and historical
 * columns are derived from the SAME voucher line, with the SAME posted filter.
 * A legacy USD voucher with no dual-currency metadata is explicitly USD; an
 * incomplete foreign voucher is UNRESOLVED, never implicitly USD.
 *
 * Only source entries booked through the company business date enter the
 * current-day valuation. This function must not be used for historic-report
 * reconstruction without enforcing historical created/deleted knowledge.
 */
async function loadNativeMovements(tx: DbTransaction, companyId: number, businessDate: string): Promise<NativeMovementRow[]> {
  const result = await tx.execute(readSql(`
    WITH customer_links AS (${customerLinksBody("$1")}),
    posted AS (
      SELECT ve.ledger_account_id, ve.bank_account_id, ve.fixed_asset_id,
             ve.supplier_id, ve.employee_id, ve.factory_supplier_id, ve.customer_id,
             CASE
               WHEN ve.transaction_currency IS NOT NULL
                AND ve.transaction_debit_amount IS NOT NULL AND ve.transaction_credit_amount IS NOT NULL
                AND ve.base_debit_amount IS NOT NULL AND ve.base_credit_amount IS NOT NULL
                 THEN CASE WHEN UPPER(TRIM(ve.transaction_currency)) = 'XOF'
                           THEN 'CFA' ELSE UPPER(TRIM(ve.transaction_currency)) END
               WHEN COALESCE(UPPER(TRIM(v.currency)), 'USD') = 'USD'
                 AND COALESCE(UPPER(TRIM(ve.transaction_currency)), 'USD') = 'USD'
                 THEN 'USD'
               ELSE '__UNRESOLVED__'
             END AS entry_currency,
             CASE
               WHEN ve.transaction_currency IS NOT NULL
                 AND ve.transaction_debit_amount IS NOT NULL AND ve.transaction_credit_amount IS NOT NULL
                 AND ve.base_debit_amount IS NOT NULL AND ve.base_credit_amount IS NOT NULL
                 THEN ve.transaction_debit_amount::numeric - ve.transaction_credit_amount::numeric
               WHEN COALESCE(UPPER(TRIM(v.currency)), 'USD') = 'USD'
                 AND COALESCE(UPPER(TRIM(ve.transaction_currency)), 'USD') = 'USD'
                 THEN COALESCE(ve.debit_amount, 0)::numeric - COALESCE(ve.credit_amount, 0)::numeric
               ELSE 0::numeric
             END AS native_net,
             CASE
               WHEN ve.transaction_currency IS NOT NULL
                 AND ve.transaction_debit_amount IS NOT NULL AND ve.transaction_credit_amount IS NOT NULL
                 AND ve.base_debit_amount IS NOT NULL AND ve.base_credit_amount IS NOT NULL
                 THEN ve.base_debit_amount::numeric - ve.base_credit_amount::numeric
               WHEN COALESCE(UPPER(TRIM(v.currency)), 'USD') = 'USD'
                 AND COALESCE(UPPER(TRIM(ve.transaction_currency)), 'USD') = 'USD'
                 THEN COALESCE(ve.base_debit_amount,ve.debit_amount,0)::numeric -
                      COALESCE(ve.base_credit_amount,ve.credit_amount,0)::numeric
               ELSE 0::numeric
             END AS historical_base_net,
             COALESCE(ve.debit_amount, 0)::numeric - COALESCE(ve.credit_amount, 0)::numeric AS posted_net
        FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
       WHERE v.company_id = $1 AND v.optional = false AND v.deleted_at IS NULL
         AND COALESCE(v.effective_date,v.voucher_date) <= $2::date
    ),
    attributed AS (
      SELECT
        CASE
          WHEN p.ledger_account_id IS NOT NULL AND la.id IS NULL THEN 'missingAccount'
          WHEN p.ledger_account_id IS NOT NULL AND cl.customer_id IS NOT NULL THEN 'customer'
          WHEN p.ledger_account_id IS NOT NULL THEN 'ledger'
          WHEN p.bank_account_id IS NOT NULL THEN 'bank'
          WHEN p.fixed_asset_id IS NOT NULL THEN 'fixedAsset'
          WHEN p.supplier_id IS NOT NULL THEN 'supplier'
          WHEN p.employee_id IS NOT NULL THEN 'employee'
          WHEN p.factory_supplier_id IS NOT NULL THEN 'factorySupplier'
          WHEN p.customer_id IS NOT NULL AND ${noNonCustomerTarget("p")} THEN 'customer'
          ELSE 'unassigned'
        END AS kind,
        CASE WHEN cl.customer_id IS NOT NULL THEN cl.customer_id
             ELSE COALESCE(p.ledger_account_id,p.bank_account_id,p.fixed_asset_id,
                           p.supplier_id,p.employee_id,p.factory_supplier_id,p.customer_id)
        END AS target_id,
        p.entry_currency, p.native_net, p.historical_base_net, p.posted_net
      FROM posted p
      LEFT JOIN ledger_accounts la ON la.id = p.ledger_account_id AND la.company_id = $1
      LEFT JOIN customer_links cl ON cl.ledger_account_id = la.id
    )
    SELECT kind, target_id, entry_currency,
           SUM(native_net)::text AS native_net,
           SUM(historical_base_net)::text AS historical_base_net,
           SUM(posted_net)::text AS posted_net,
           COUNT(*) FILTER (WHERE entry_currency = '__UNRESOLVED__')::text AS unresolved_count
    FROM attributed
    WHERE kind IN ('ledger', 'bank', 'customer') AND target_id IS NOT NULL
    GROUP BY kind, target_id, entry_currency
  `, companyId, businessDate));
  return resultRows<NativeMovementRow & Record<string, unknown>>(result);
}

/**
 * Parameterize the two static report queries as Drizzle SQL fragments.
 * Every $1 / $2 is converted into a bound parameter, not interpolated SQL.
 * This keeps tenant RLS context and every SELECT on the same transaction.
 */
function readSql(query: string, companyId: number, businessDate?: string) {
  const chunks = query.split(/(\$1|\$2)/g).filter(Boolean).map((chunk) =>
    chunk === "$1" ? sql`${companyId}` :
    chunk === "$2" ? sql`${businessDate}` : sql.raw(chunk)
  );
  return sql.join(chunks, sql``);
}

/** The existing audited datedMonetaryRateTx is authoritative for directions/conflicts. */
async function resolveValuationRates(
  tx: DbTransaction, companyId: number, day: string, currencies: ReadonlySet<string>
): Promise<{ rates: MonetaryFxRateMap; errors: Record<string, string> }> {
  const rates = new Map<string, MonetaryFxRate>();
  const errors: Record<string, string> = {};
  for (const code of [...currencies].sort()) {
    if (code === "USD") continue;
    try {
      const quote = await datedMonetaryRateTx(tx, companyId, code, day);
      if (!quote) {
        errors[code] = "FX_RATE_MISSING";
        continue;
      }
      rates.set(code, {
        currency: code,
        rate: quote.source === "DIRECT_RECORDED" ? quote.rateUnitPerBase : quote.rateBasePerUnit,
        direction: quote.source === "DIRECT_RECORDED" ? "FOREIGN_PER_USD" : "USD_PER_FOREIGN",
        effectiveDate: quote.effectiveDate,
      });
    } catch (error) {
      if (!(error instanceof MonetaryFxError)) throw error;
      // A conflicting stored EUR rate must not prevent a valid CFA account
      // from being valued. It does, however, make all affected EUR rows
      // provisional until an audited rate-history repair is approved.
      errors[code] = error.code;
    }
  }
  return { rates, errors };
}

function decimal(input: string | number | null | undefined): Decimal {
  return new Decimal(input ?? "0");
}

/** Primary Phase 2 read model. No rate writes or posting side effects. */
export async function getMonetaryFxValuation(
  companyId: number,
  // Only trusted server-side policy data may approve additional monetary assets.
  policy: MonetaryFxEligibilityOptions = {}
): Promise<MonetaryFxValuationResult> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error("A selected company is required.");
  return db.transaction(async (tx) => {
    // One consistent account/rate snapshot; never hold a writable transaction.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await assertTransactionCompanyScope(tx, companyId);
    const [company] = resultRows<{ base_currency: string | null } & Record<string, unknown>>(
      await tx.execute(sql`SELECT base_currency FROM companies WHERE id = ${companyId}`)
    );
    if (!company) throw new Error("Company not found.");
    const businessDate = fxDay(await companyBusinessDate(companyId, tx));
    const baseCurrency = canonicalMonetaryCurrency(company.base_currency) ?? "USD";
    const masters = await loadMonetaryMasters(tx, companyId);
    const movements = await loadNativeMovements(tx, companyId, businessDate);
    // Only rate-check eligible accounts. A malformed or unrelated currency on
    // a supplier/nonmonetary/ambiguous Asset must not poison every valuation.
    const eligibleKeys = new Set<string>();
    const currencies = new Set<string>();
    for (const master of masters) {
      const eligibility = monetaryFxEligibility({
        kind: master.kind, id: Number(master.id), code: master.code,
        name: master.name, accountType: master.account_type, subType: master.sub_type,
      }, policy);
      if (eligibility === "excluded" || eligibility === "needs_review") continue;
      eligibleKeys.add(`${master.kind}:${master.id}`);
      const currency = canonicalMonetaryCurrency(master.opening_balance_currency);
      if (currency) currencies.add(currency);
    }
    for (const movement of movements) {
      if (!eligibleKeys.has(`${movement.kind}:${movement.target_id}`)) continue;
      const currency = canonicalMonetaryCurrency(movement.entry_currency);
      if (currency) currencies.add(currency);
    }
    const rateResolution = baseCurrency === "USD"
      ? await resolveValuationRates(tx, companyId, businessDate, currencies)
      : { rates: new Map<string, MonetaryFxRate>(), errors: {} as Record<string, string> };
    const rates = rateResolution.rates;
  const movementsByKey = new Map<string, NativeMovementRow[]>();
  for (const movement of movements) {
    const key = `${movement.kind}:${movement.target_id}`;
    const list = movementsByKey.get(key) ?? [];
    list.push(movement);
    movementsByKey.set(key, list);
  }

  let excludedMasters = 0;
  const customerLinkedLedgerMasters = masters.filter((m) => m.kind === "customer" && m.linked_ledger_id != null).length;
  const accounts: MonetaryFxValuationRow[] = [];
  for (const master of masters) {
    const eligibility = monetaryFxEligibility({
      kind: master.kind, id: Number(master.id), code: master.code,
      name: master.name, accountType: master.account_type, subType: master.sub_type,
    }, policy);
    if (eligibility === "excluded") {
      excludedMasters++;
      continue;
    }
    const accountKey = `${master.kind}:${master.id}`;
    const native = new Map<string, Decimal>();
    let historical = new Decimal(0);
    // The engine's book closing: signed master opening + every posted line's
    // debit_amount - credit_amount, unresolved currency evidence included.
    let bookClosing = new Decimal(0);
    let unresolvedOpening = false;
    let openingBookMismatch = false;
    let unresolvedEntryCount = 0;
    for (const movement of movementsByKey.get(accountKey) ?? []) {
      bookClosing = bookClosing.plus(decimal(movement.posted_net));
      if (movement.entry_currency === "__UNRESOLVED__") {
        unresolvedEntryCount += Number(movement.unresolved_count) || 0;
        continue;
      }
      const currency = canonicalMonetaryCurrency(movement.entry_currency);
      if (!currency) {
        unresolvedEntryCount++;
        continue;
      }
      native.set(currency, (native.get(currency) ?? new Decimal(0)).plus(decimal(movement.native_net)));
      historical = historical.plus(decimal(movement.historical_base_net));
    }

    const opening = decimal(master.opening_balance);
    const openingSign =
      openingSideOf(master.kind, master.account_type, master.opening_balance_side).side === "Cr" ? -1 : 1;
    bookClosing = bookClosing.plus(opening.mul(openingSign));
    // A zero historical opening cannot quietly carry a nonzero *native*
    // opening. Such a discrepancy needs review, not a newly invented USD
    // balance after a rate change.
    if (opening.isZero() && (
      (master.opening_balance_base_amount != null &&
        decimal(master.opening_balance_base_amount).abs().gt("0.03")) ||
      (master.opening_balance_native_amount != null &&
        !decimal(master.opening_balance_native_amount).isZero())
    )) {
      unresolvedOpening = true;
      openingBookMismatch = true;
    }
    if (!opening.isZero()) {
      const currency = canonicalMonetaryCurrency(master.opening_balance_currency);
      if (
        !currency || master.opening_balance_native_amount === null ||
        master.opening_balance_base_amount === null
      ) {
        unresolvedOpening = true;
      } else {
        const sign = openingSign;
        const nativeOpening = decimal(master.opening_balance_native_amount);
        const baseOpening = decimal(master.opening_balance_base_amount);
        // The balance engine's immutable/book opening is opening_balance.
        // If the supplemental currency metadata disagrees with the actual
        // book, we cannot safely translate the account. Preserve book USD.
        if (!nativeOpening.isFinite() || !baseOpening.isFinite() ||
            baseOpening.minus(opening.abs()).abs().gt("0.03")) {
          openingBookMismatch = true;
          unresolvedOpening = true;
        } else {
          native.set(currency, (native.get(currency) ?? new Decimal(0))
            .plus(nativeOpening.mul(sign)));
          historical = historical.plus(baseOpening.mul(sign));
        }
      }
    }

    // No source current USD can be trusted if original currency is unresolved,
    // or if an unverified non-USD company base is mistaken for USD.
    const unresolved = unresolvedOpening || unresolvedEntryCount > 0 || baseCurrency !== "USD";
    const calculation = translateMonetaryFxBalance(native, unresolved ? null : historical, rates, unresolved);
    accounts.push({
      accountKey,
      accountKind: master.kind,
      id: Number(master.id),
      linkedLedgerId: master.linked_ledger_id === null ? null : Number(master.linked_ledger_id),
      code: master.code ?? "",
      name: master.name,
      category: eligibility,
      eligibility,
      deleted: Boolean(master.deleted),
      nativeBalancesByCurrency: calculation.nativeBalancesByCurrency,
      historicalBaseUsd: calculation.historicalBaseUsd,
      bookClosingUsd: bookClosing.toDecimalPlaces(6).toFixed(6),
      // Unapproved generic assets must never receive an automatic valuation.
      currentTranslatedUsd: eligibility === "needs_review" ? null : calculation.currentTranslatedUsd,
      translationDifferenceUsd: eligibility === "needs_review" ? null : calculation.translationDifferenceUsd,
      unresolvedCurrencies: calculation.unresolvedCurrencies,
      unresolvedEntryCount,
      unresolvedOpening,
      openingBookMismatch,
      provisional: eligibility === "needs_review" || calculation.provisional,
    });
  }
  accounts.sort((a,b)=>a.accountKey.localeCompare(b.accountKey));
  return {
    companyId, businessDate, valuationMode: "CURRENT", baseCurrency,
    bookBalancesModified: false, fxVouchersPosted: false,
    accounts,
    rates: [...rates.values()].sort((a,b)=>a.currency.localeCompare(b.currency)),
    rateErrorsByCurrency: rateResolution.errors,
    eligibleAccountCount: accounts.filter(a=>a.eligibility!=="needs_review").length,
    unresolvedAccountCount: accounts.filter(a=>a.provisional && a.eligibility!=="needs_review").length,
    needsReviewCount: accounts.filter(a=>a.eligibility==="needs_review").length,
    excludedLedgerAndPartyCounts: { excludedMasters, customerLinkedLedgerMasters },
  };
  });
}
