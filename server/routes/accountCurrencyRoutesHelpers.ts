// Extracted from ./accountCurrencyRoutes.ts
import Decimal from "decimal.js";
import { and, eq, isNull } from "drizzle-orm";
import { db, pool } from "../db";
import { bankAccounts, ledgerAccounts } from "@shared/schema";
import { normalizeOpeningBalanceCurrency } from "../services/accounting/openingBalanceCurrency";
import { openingSideOf } from "../services/accounting/balances/openingSide";

export const OPENING_FIELDS = [
  "openingBalance",
  "openingBalanceSide",
  "openingBalanceNativeAmount",
  "openingBalanceCurrency",
  "openingBalanceHistoricalRate",
  "openingBalanceBaseAmount",
] as const;

const EXPLICIT_CURRENCY_FIELDS = [
  "openingBalanceNativeAmount",
  "openingBalanceCurrency",
  "openingBalanceHistoricalRate",
  "openingBalanceBaseAmount",
] as const;

export async function accountExistsInCompany(companyId: number, accountId: number): Promise<boolean> {
  const [ledger] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)))
    .limit(1);
  if (ledger) return true;
  const [bank] = await db
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, accountId), eq(bankAccounts.companyId, companyId)))
    .limit(1);
  return Boolean(bank);
}

/** Flat account-payload values at the JSON/row boundary: strings, numbers, or absent. */
type AccountPayload = Record<string, string | number | null | undefined>;

type ExistingAccount = typeof ledgerAccounts.$inferSelect | typeof bankAccounts.$inferSelect;

export function hasOwn(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function unresolvedOpeningPayload(body: AccountPayload, rawAmount: Decimal): AccountPayload {
  return {
    ...body,
    openingBalance: rawAmount.toFixed(),
    openingBalanceNativeAmount: null,
    openingBalanceCurrency: null,
    openingBalanceHistoricalRate: null,
    openingBalanceBaseAmount: null,
  };
}

export function normalizedOpeningPayload(
  body: AccountPayload,
  existing: ExistingAccount | null,
  baseCurrency: string
): AccountPayload {
  const hasExplicitCurrencyPayload = EXPLICIT_CURRENCY_FIELDS.some((field) => hasOwn(body, field));
  const existingIsResolved = Boolean(
    existing?.openingBalanceNativeAmount != null &&
    existing?.openingBalanceCurrency &&
    existing?.openingBalanceBaseAmount != null
  );

  // Old edit forms submit only openingBalance, which is historical base after a
  // record has been resolved. Preserve the locked native/rate metadata when that
  // base value is unchanged. If an old form changes it without currency details,
  // make it unresolved rather than pretending the edited number is USD or CFA.
  if (existing && existingIsResolved && !hasExplicitCurrencyPayload) {
    const submittedLegacyAmount = hasOwn(body, "openingBalance")
      ? new Decimal(body.openingBalance || 0)
      : new Decimal(existing.openingBalanceBaseAmount || existing.openingBalance || 0);
    const existingBase = new Decimal(existing.openingBalanceBaseAmount || existing.openingBalance || 0);

    if (!submittedLegacyAmount.isFinite() || submittedLegacyAmount.lt(0)) {
      throw new Error("Opening balance must be a finite non-negative amount.");
    }
    if (submittedLegacyAmount.eq(existingBase)) {
      return {
        ...body,
        openingBalance: existingBase.toFixed(),
        openingBalanceNativeAmount: existing.openingBalanceNativeAmount,
        openingBalanceCurrency: existing.openingBalanceCurrency,
        openingBalanceHistoricalRate: existing.openingBalanceHistoricalRate,
        openingBalanceBaseAmount: existing.openingBalanceBaseAmount,
      };
    }
    return unresolvedOpeningPayload(body, submittedLegacyAmount);
  }

  const nativeOpeningBalance =
    body.openingBalanceNativeAmount ??
    body.openingBalance ??
    existing?.openingBalanceNativeAmount ??
    existing?.openingBalance ??
    "0";
  const amount = new Decimal(nativeOpeningBalance || 0);
  const rawCurrency = (body.openingBalanceCurrency ?? existing?.openingBalanceCurrency ?? null) as
    string | null | undefined;

  if (!amount.isFinite() || amount.lt(0)) {
    throw new Error("Opening balance must be a finite non-negative amount.");
  }

  // Never guess a non-zero opening balance's currency. Keep the legacy raw
  // amount visible and explicitly unresolved until an operator reviews it in
  // Accounts → Resolve Historical Opening & Asset Values.
  if (!amount.isZero() && !rawCurrency) {
    return unresolvedOpeningPayload(body, amount);
  }

  const normalized = normalizeOpeningBalanceCurrency({
    openingBalance: nativeOpeningBalance,
    openingBalanceCurrency: rawCurrency,
    openingBalanceHistoricalRate: body.openingBalanceHistoricalRate ?? existing?.openingBalanceHistoricalRate,
    openingBalanceBaseAmount: body.openingBalanceBaseAmount ?? existing?.openingBalanceBaseAmount,
    baseCurrency,
  });

  return {
    ...body,
    ...normalized,
    // Existing reports read openingBalance. Keep it in historical base currency;
    // the original amount is preserved in openingBalanceNativeAmount.
    openingBalance: normalized.openingBalanceBaseAmount,
  };
}

export async function getHistoricalLedgerBalance(companyId: number, ledgerAccountId: number, asOf?: string) {
  const [account] = await db
    .select()
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, ledgerAccountId),
        eq(ledgerAccounts.companyId, companyId),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  if (!account) return null;

  const result = await pool.query<{
    historical_net: string;
    unresolved_count: string;
    unresolved_raw_net: string;
  }>(
    `SELECT
       COALESCE(SUM(
         CASE
           WHEN ve.base_debit_amount IS NOT NULL OR ve.base_credit_amount IS NOT NULL
             THEN COALESCE(ve.base_debit_amount, 0)::numeric - COALESCE(ve.base_credit_amount, 0)::numeric
           WHEN COALESCE(UPPER(v.currency), 'USD') = 'USD'
             THEN COALESCE(ve.debit_amount, 0)::numeric - COALESCE(ve.credit_amount, 0)::numeric
           ELSE 0::numeric
         END
       ), 0)::text AS historical_net,
       COALESCE(SUM(
         CASE WHEN ve.base_debit_amount IS NULL AND ve.base_credit_amount IS NULL
                    AND COALESCE(UPPER(v.currency), 'USD') <> 'USD'
              THEN 1 ELSE 0 END
       ), 0)::text AS unresolved_count,
       COALESCE(SUM(
         CASE WHEN ve.base_debit_amount IS NULL AND ve.base_credit_amount IS NULL
                    AND COALESCE(UPPER(v.currency), 'USD') <> 'USD'
              THEN COALESCE(ve.debit_amount, 0)::numeric - COALESCE(ve.credit_amount, 0)::numeric
              ELSE 0::numeric END
       ), 0)::text AS unresolved_raw_net
     FROM voucher_entries ve
     JOIN vouchers v ON v.id = ve.voucher_id
     WHERE ve.ledger_account_id = $1
       AND v.company_id = $2
       AND v.optional = false
       AND v.deleted_at IS NULL
       ${asOf ? "AND COALESCE(v.effective_date, v.voucher_date) <= $3::date" : ""}`,
    asOf ? [ledgerAccountId, companyId, asOf] : [ledgerAccountId, companyId]
  );

  let historicalBalance = new Decimal(result.rows[0]?.historical_net || 0);
  // The engine's one sideless-opening rule (wave 17 A): a sideless opening
  // takes its account type's usual side (it was read as Dr).
  const openingIsCr = openingSideOf("ledger", account.accountType, account.openingBalanceSide).side === "Cr";
  const openingBase = new Decimal(account.openingBalanceBaseAmount || account.openingBalance || 0);
  const openingNative = new Decimal(account.openingBalanceNativeAmount || 0);
  const hasNonZeroOpening = !openingBase.isZero() || !openingNative.isZero();
  const openingBalanceCurrencyUnresolved =
    hasNonZeroOpening &&
    (!account.openingBalanceCurrency || !account.openingBalanceBaseAmount || !account.openingBalanceNativeAmount);
  if (!openingBalanceCurrencyUnresolved && !openingBase.isZero()) {
    historicalBalance = historicalBalance.plus(openingIsCr ? openingBase.neg() : openingBase);
  }

  return {
    account,
    historicalBaseBalance: historicalBalance.toDecimalPlaces(6).toFixed(6),
    unresolvedLegacyEntryCount: Number.parseInt(result.rows[0]?.unresolved_count || "0", 10) || 0,
    unresolvedLegacyNetRaw: new Decimal(result.rows[0]?.unresolved_raw_net || 0).toDecimalPlaces(6).toFixed(6),
    openingBalanceCurrencyUnresolved,
    unresolvedOpeningBalanceRaw: openingBalanceCurrencyUnresolved
      ? new Decimal(account.openingBalance || 0)
          .times(openingIsCr ? -1 : 1)
          .toDecimalPlaces(6)
          .toFixed(6)
      : null,
  };
}
