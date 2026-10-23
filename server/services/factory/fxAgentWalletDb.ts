/** Safe, company-scoped reads for the FX-agent extension. */
import { sql } from "drizzle-orm";
import { db, type DatabaseOrTransaction } from "../../db";
import { toMoney } from "../../lib/money";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { netPositionRecordedThrough } from "./netPositionAsOf";
import { getPartyBalance } from "../accounting/balances/ledgerBalanceEngine";
import {
  replayFxAgentWallet,
  walletCurrentUsd,
  type FxAgentWalletEvent,
  type FxAgentWalletState,
} from "./fxAgentWalletState";

type QueryRow = Record<string, unknown>;
export interface FxAgentWalletRow {
  id: number;
  companyId: number;
  ledgerAccountId: number;
  accountName: string;
  accountCode: string;
  openingUsd: string;
  activatedOn: string;
}
export interface FxAgentWalletSnapshot {
  wallet: FxAgentWalletRow;
  state: FxAgentWalletState;
  ledgerBookUsd: string;
  bookDifferenceUsd: string;
  synchronized: boolean;
  latestOperationDate: string | null;
  hasOperations: boolean;
  currentRateUsdPerEur: string | null;
  currentUsd: string | null;
}

export async function fxAgentTablesExist(executor: DatabaseOrTransaction = db): Promise<boolean> {
  const result = await executor.execute(sql`SELECT to_regclass('factory_fx_agent_wallets')::text AS wallets,
    to_regclass('factory_fx_agent_wallet_operations')::text AS movements`);
  return Boolean(result.rows[0]?.wallets && result.rows[0]?.movements);
}

export async function loadFxAgentWallets(
  companyId: number,
  asOf?: string,
  executor: DatabaseOrTransaction = db,
  knownAt?: FactoryNetPositionAsOf
): Promise<FxAgentWalletRow[]> {
  if (knownAt?.isHistorical && asOf !== knownAt.asOf) {
    throw new Error("HISTORICAL_FX_WALLET_DATE_MISMATCH");
  }
  const found = await executor.execute(sql`
    SELECT w.id, w.company_id AS "companyId", w.ledger_account_id AS "ledgerAccountId",
      a.name AS "accountName", a.code AS "accountCode", w.opening_usd::text AS "openingUsd",
      w.activated_on::text AS "activatedOn"
    FROM factory_fx_agent_wallets w JOIN ledger_accounts a ON a.id = w.ledger_account_id
    WHERE w.company_id = ${companyId} AND a.company_id = ${companyId}
      ${
        knownAt?.isHistorical
          ? sql`AND (a.deleted_at IS NULL
                   OR NOT ${netPositionRecordedThrough(sql`a.deleted_at`, knownAt, "utc-naive-timestamp")})
               AND ${netPositionRecordedThrough(sql`a.created_at`, knownAt, "utc-naive-timestamp")}
               AND ${netPositionRecordedThrough(sql`w.created_at`, knownAt, "timestamptz")}`
          : sql`AND a.deleted_at IS NULL`
      }
      ${asOf ? sql`AND w.activated_on <= ${asOf}::date` : sql``}
    ORDER BY a.name, w.id
  `);
  return found.rows.map((row: QueryRow) => ({
    id: Number(row.id),
    companyId: Number(row.companyId),
    ledgerAccountId: Number(row.ledgerAccountId),
    accountName: String(row.accountName),
    accountCode: String(row.accountCode),
    openingUsd: String(row.openingUsd),
    activatedOn: String(row.activatedOn).slice(0, 10),
  }));
}

export async function loadFxAgentWalletState(
  wallet: FxAgentWalletRow,
  asOf: string,
  executor: DatabaseOrTransaction = db,
  knownAt?: FactoryNetPositionAsOf
): Promise<{ state: FxAgentWalletState; latestOperationDate: string | null; hasOperations: boolean }> {
  if (knownAt?.isHistorical && asOf !== knownAt.asOf) {
    throw new Error("HISTORICAL_FX_WALLET_DATE_MISMATCH");
  }
  const result = await executor.execute(sql`
    SELECT kind, source_amount::text AS "sourceAmount", target_amount::text AS "targetAmount",
      source_book_usd::text AS "sourceBookUsd", effective_date::text AS "effectiveDate"
    FROM factory_fx_agent_wallet_operations
    WHERE company_id = ${wallet.companyId} AND wallet_id = ${wallet.id}
      AND effective_date <= ${asOf}::date
      ${knownAt?.isHistorical ? sql`AND ${netPositionRecordedThrough(sql`created_at`, knownAt, "timestamptz")}` : sql``}
    ORDER BY effective_date, id
  `);
  const events = result.rows.map((row: QueryRow) => ({
    kind: row.kind as FxAgentWalletEvent["kind"],
    sourceAmount: String(row.sourceAmount),
    targetAmount: String(row.targetAmount),
    sourceBookUsd: String(row.sourceBookUsd),
  }));
  return {
    state: replayFxAgentWallet(wallet.openingUsd, events),
    hasOperations: events.length > 0,
    latestOperationDate: result.rows.length
      ? String(result.rows[result.rows.length - 1].effectiveDate).slice(0, 10)
      : null,
  };
}

export async function getFxAgentWalletSnapshot(
  wallet: FxAgentWalletRow,
  asOf: string,
  executor: DatabaseOrTransaction = db,
  rateUsdPerEur: string | null = null,
  historical?: { scope: FactoryNetPositionAsOf; ledgerBookUsd: string }
): Promise<FxAgentWalletSnapshot> {
  const { state, latestOperationDate, hasOperations } = await loadFxAgentWalletState(
    wallet,
    asOf,
    executor,
    historical?.scope
  );
  // The Factory historical report already reconstructs ledger entries using
  // both business and recorded-at dates. getPartyBalance(asOf) alone does not
  // enforce recorded-at, and would compare the wallet against a future edit.
  let book: ReturnType<typeof toMoney>;
  if (historical?.scope.isHistorical) {
    if (historical.scope.asOf !== asOf) throw new Error("HISTORICAL_FX_WALLET_DATE_MISMATCH");
    book = toMoney(historical.ledgerBookUsd);
  } else {
    const ledger = await getPartyBalance(executor, {
      kind: "ledger",
      companyId: wallet.companyId,
      id: wallet.ledgerAccountId,
      asOf,
    });
    if (!ledger) throw new Error("FX agent ledger account is missing");
    book = toMoney(ledger.historicalBaseClosing);
  }
  const difference = book.minus(state.totalBookUsd);
  const currentUsd = rateUsdPerEur
    ? walletCurrentUsd(state, rateUsdPerEur)
    : toMoney(state.eur).isZero()
      ? state.usd
      : null;
  return {
    wallet,
    state,
    ledgerBookUsd: book.toFixed(6),
    bookDifferenceUsd: difference.toFixed(6),
    synchronized: difference.abs().lte("0.01"),
    latestOperationDate,
    hasOperations,
    currentRateUsdPerEur: rateUsdPerEur,
    currentUsd,
  };
}
