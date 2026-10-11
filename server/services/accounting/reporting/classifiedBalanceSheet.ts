/**
 * Classified balance sheet on the one balance engine (accounting audit
 * phase 27, RP-4/RP-6/RP-8).
 *
 * One engine scan (loadBalanceRows) as of `asOf`, with the fiscal year's first
 * day as the period start, gives every row's balance before the year and its
 * movement inside it:
 *   - income and expense rows are earnings: what they held before the fiscal
 *     year (calendar year, decided by default) is the "retained earnings not
 *     yet closed" line, their movement inside it the current-year earnings.
 *     A fiscal close moves the profit into the RETAINED_EARNINGS account (an
 *     equity line), so after a close the unclosed line is zero;
 *   - every other row is placed by classificationMap.statementSectionOf:
 *     current / non-current assets and liabilities, equity, unclassified; an
 *     overdrawn bank and a party in credit are current liabilities;
 *   - the difference (assets − liabilities − equity − unclassified) is the
 *     trial balance's unexplained difference, never plugged.
 * Amounts are exact Decimals, reported as 2-decimal strings.
 */
import { eq } from "drizzle-orm";
import type Decimal from "decimal.js";
import { ledgerAccounts } from "@shared/schema";

import { db, type DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal } from "../../../lib/money";
import { loadBalanceRows, type BalanceRow } from "../balances/ledgerBalanceEngine";
import {
  fiscalYearEnd,
  fiscalYearStart,
  isCashRow,
  statementSectionOf,
  type StatementSection,
} from "./classificationMap";

export interface ClassifiedLine {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  subType: string | null;
  section: Exclude<StatementSection, "earnings">;
  cash: boolean;
  /** Positive on the side of its section (an asset's debit, a liability's credit). */
  balance: string;
}

export interface ClassifiedSection {
  lines: ClassifiedLine[];
  total: string;
}

export interface ClassifiedBalanceSheet {
  companyId: number;
  asOf: string | null;
  fiscalYear: { start: string; end: string } | null;
  currentAssets: ClassifiedSection;
  nonCurrentAssets: ClassifiedSection;
  currentLiabilities: ClassifiedSection;
  nonCurrentLiabilities: ClassifiedSection;
  equity: ClassifiedSection & {
    /** Income/expense balances from before the fiscal year that no close has moved yet. */
    retainedEarnings: string;
    /** Income/expense movement inside the fiscal year (fiscal closes included). */
    currentEarnings: string;
  };
  unclassified: ClassifiedSection;
  totals: {
    assets: string;
    liabilities: string;
    equity: string;
    netAssets: string;
    cash: string;
  };
  difference: string;
  balanced: boolean;
}

const ZERO = new MoneyDecimal(0);

/** sub_type of the company's ledger accounts (the engine rows carry only the type). */
export async function ledgerSubTypeMap(
  companyId: number,
  executor: DatabaseOrTransaction = db
): Promise<Map<number, string | null>> {
  const rows = await executor
    .select({ id: ledgerAccounts.id, subType: ledgerAccounts.subType })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.companyId, companyId))
    .execute();
  return new Map(rows.map((row) => [row.id, row.subType ?? null] as const));
}

export function rowSubType(row: Pick<BalanceRow, "kind" | "id">, subTypes: Map<number, string | null>): string | null {
  return row.kind === "ledger" && row.id !== null ? (subTypes.get(row.id) ?? null) : null;
}

/** Debit-positive closing of an engine row. */
export function rowClosing(row: BalanceRow): Decimal {
  return row.masterOpening.plus(row.carriedForward).plus(row.periodDebit).minus(row.periodCredit);
}

function sectionOf(lines: ClassifiedLine[]): ClassifiedSection {
  return {
    lines,
    total: lines.reduce((sum, line) => sum.plus(line.balance), new MoneyDecimal(0)).toFixed(2),
  };
}

export interface ClassifiedBalanceSheetOptions {
  executor?: DatabaseOrTransaction;
  /** Override the fiscal-year start (tests); defaults to the calendar year of `asOf`. */
  fiscalYearStart?: string | null;
}

export async function buildClassifiedBalanceSheet(
  companyId: number,
  asOf: string | null,
  options: ClassifiedBalanceSheetOptions = {}
): Promise<ClassifiedBalanceSheet> {
  const executor = options.executor ?? db;
  const fyStart = options.fiscalYearStart ?? (asOf ? fiscalYearStart(asOf) : null);
  const [rows, subTypes] = await Promise.all([
    loadBalanceRows(executor, { companyId, asOf, from: fyStart }),
    ledgerSubTypeMap(companyId, executor),
  ]);

  const buckets: Record<Exclude<StatementSection, "earnings">, ClassifiedLine[]> = {
    currentAssets: [],
    nonCurrentAssets: [],
    currentLiabilities: [],
    nonCurrentLiabilities: [],
    equity: [],
    unclassified: [],
  };
  let retained: Decimal = ZERO;
  let current: Decimal = ZERO;
  let cash: Decimal = ZERO;

  for (const row of rows) {
    const subType = rowSubType(row, subTypes);
    const classifiable = { kind: row.kind, accountType: row.accountType, subType };
    const closing = rowClosing(row);
    const section = statementSectionOf(classifiable, closing);
    if (section === "earnings") {
      // Credit-positive: income raises earnings.
      retained = retained.minus(row.masterOpening.plus(row.carriedForward));
      current = current.minus(row.periodDebit.minus(row.periodCredit));
      continue;
    }
    if (closing.isZero()) continue;
    const isCash = isCashRow(classifiable);
    if (isCash) cash = cash.plus(closing);
    const assetSide = section === "currentAssets" || section === "nonCurrentAssets";
    buckets[section].push({
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.accountType,
      subType,
      section,
      cash: isCash,
      balance: (assetSide ? closing : closing.negated()).toFixed(2),
    });
  }
  for (const lines of Object.values(buckets)) {
    lines.sort((a, b) => (a.code ?? a.name).localeCompare(b.code ?? b.name) || (a.id ?? 0) - (b.id ?? 0));
  }

  const currentAssets = sectionOf(buckets.currentAssets);
  const nonCurrentAssets = sectionOf(buckets.nonCurrentAssets);
  const currentLiabilities = sectionOf(buckets.currentLiabilities);
  const nonCurrentLiabilities = sectionOf(buckets.nonCurrentLiabilities);
  const equityLines = sectionOf(buckets.equity);
  const unclassified = sectionOf(buckets.unclassified);

  const assets = new MoneyDecimal(currentAssets.total).plus(nonCurrentAssets.total);
  const liabilities = new MoneyDecimal(currentLiabilities.total).plus(nonCurrentLiabilities.total);
  const equity = new MoneyDecimal(equityLines.total).plus(retained).plus(current);
  const difference = assets.minus(liabilities).minus(equity).minus(unclassified.total);

  return {
    companyId,
    asOf,
    fiscalYear: fyStart && asOf ? { start: fyStart, end: fiscalYearEnd(asOf) } : null,
    currentAssets,
    nonCurrentAssets,
    currentLiabilities,
    nonCurrentLiabilities,
    equity: {
      ...equityLines,
      retainedEarnings: retained.toFixed(2),
      currentEarnings: current.toFixed(2),
      total: equity.toFixed(2),
    },
    unclassified,
    totals: {
      assets: assets.toFixed(2),
      liabilities: liabilities.toFixed(2),
      equity: equity.toFixed(2),
      netAssets: assets.minus(liabilities).toFixed(2),
      cash: cash.toFixed(2),
    },
    difference: difference.toFixed(2),
    balanced: difference.isZero(),
  };
}
