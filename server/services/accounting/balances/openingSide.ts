/**
 * The one sideless-opening rule of the balance engine (wave 13 C1, wave 17 A).
 * Kept apart from ledgerBalanceEngine.ts so light readers (the fiscal close,
 * the ledger balance route) can use it without loading the engine's SQL.
 */
import type Decimal from "decimal.js";

import { toMoney } from "../../../lib/money";
import { defaultOpeningSide as defaultOpeningSideOfType } from "../accountClassification";

/** A master record kind of the engine (ledgerBalanceEngine's PartyBalanceKind and its two line-only rows). */
export type OpeningSideKind =
  | "ledger"
  | "bank"
  | "fixedAsset"
  | "supplier"
  | "employee"
  | "factorySupplier"
  | "customer"
  | "missingAccount"
  | "unassigned";

/**
 * Default side for an opening stored without one. A ledger account takes the
 * usual side of its type (wave 13, C1: Dr for assets and expenses, Cr for
 * liabilities, equity and income); before, every sideless ledger opening was
 * Dr. Other masters keep their record type's side (suppliers, employees and
 * factory suppliers Cr; customers, banks and fixed assets Dr), as does a
 * ledger account whose type the classifier does not know.
 */
export function defaultOpeningSide(kind: OpeningSideKind, accountType: string | null): "Dr" | "Cr" {
  if (kind === "ledger") {
    const byType = defaultOpeningSideOfType(accountType);
    if (byType) return byType;
  }
  return kind === "supplier" || kind === "employee" || kind === "factorySupplier" ? "Cr" : "Dr";
}

/** The side of a master's opening: its stored side, else the default above (`assumed`). */
export function openingSideOf(
  kind: OpeningSideKind,
  accountType: string | null | undefined,
  storedSide: string | null | undefined
): { side: "Dr" | "Cr"; assumed: boolean } {
  if (storedSide === "Dr" || storedSide === "Cr") return { side: storedSide, assumed: false };
  return { side: defaultOpeningSide(kind, accountType ?? null), assumed: true };
}

/** A master opening, debit positive, on the rule above. */
export function signedMasterOpening(
  kind: OpeningSideKind,
  accountType: string | null | undefined,
  openingBalance: string | number | null | undefined,
  storedSide: string | null | undefined
): Decimal {
  const amount = toMoney(openingBalance);
  return openingSideOf(kind, accountType, storedSide).side === "Cr" ? amount.negated() : amount;
}
