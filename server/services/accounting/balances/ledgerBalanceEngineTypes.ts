// Extracted from ./ledgerBalanceEngine.ts
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { type PartyBalanceMemoLine } from "./unpostedMemo";
import { type BalanceRowKind, type PartyBalanceKind } from "./ledgerBalanceEngineLiveVouchersOf";

/** A party's ledger balance. Amounts are 2-decimal strings, debit positive. */
export interface PartyBalance {
  kind: BalanceRowKind;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  deleted: boolean;
  linkedLedgerAccountId: number | null;
  /** The master record's opening with its side. */
  masterOpening: string;
  /** Net movements before `from` (zero without `from`). */
  carriedForward: string;
  /** Balance at the start of the period: masterOpening + carriedForward. */
  opening: string;
  periodDebit: string;
  periodCredit: string;
  /** opening + periodDebit − periodCredit. */
  closing: string;
  /** masterOpening + historical base amounts of every line up to `asOf` (USD at posting rates). */
  historicalBaseClosing: string;
  openingSideAssumed: boolean;
  /**
   * Amounts that are not in the ledger yet (owner rule 3), dated on or before
   * `asOf`: listed only when the query asks for them (`memo: true`), never
   * part of `closing`.
   */
  memoLines: PartyBalanceMemoLine[];
  /** Sum of memoLines (debit positive), reported next to `closing`, never in it. */
  memoTotal: string;
}

export interface PartyBalanceQuery {
  knownAt?: FactoryNetPositionAsOf;
  companyId: number;
  kind: PartyBalanceKind;
  ids?: readonly number[];
  /** Inclusive end; omitted for everything posted. */
  asOf?: string | null;
  /** Inclusive start of the period; omitted for opening-to-date. */
  from?: string | null;
  /** Attach the "not yet in the ledger" memo lines (customers and factory suppliers). */
  memo?: boolean;
}

export interface PartyBalanceResult {
  companyId: number;
  kind: PartyBalanceKind;
  basis: "ledger";
  period: { from: string | null; to: string | null };
  parties: PartyBalance[];
}
