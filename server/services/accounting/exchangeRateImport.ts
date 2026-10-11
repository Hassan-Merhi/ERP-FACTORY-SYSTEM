/**
 * Dated exchange-rate imports (Owner "Accounting clean-up" page, card 2).
 *
 * A rates file (for example the prepared ECB table) is saved in one request:
 *
 *   - Factory rates (`factory_fx_rates`, POST /api/factory/fx-rates/batch):
 *     each row adds a manual rate effective from its date, as POST
 *     /api/factory/fx-rates does one at a time.
 *   - Company rates (`exchange_rates`, POST /api/exchange-rates/batch): each
 *     row saves the company rate for its date and pair, as POST
 *     /api/exchange-rates does (one row per company, date and pair).
 *
 * Both validate every row before anything is written (currency, ISO date, a
 * positive rate, no date after the company's business date, no row twice),
 * classify each row against the rate already recorded for its date (new,
 * identical, conflicting), skip identical rows, refuse conflicting rows unless
 * the request says to replace them, and write the rates and ONE audit row
 * (every rate before and after) in one transaction. Nothing is written when a
 * row is refused.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { exchangeRates, factoryFxRates } from "@shared/schema";

import { db, type DbTransaction } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import { writeAuditEvent, type AuditActor } from "../audit";
import { companyBusinessDate } from "./companyBusinessDate";

export const RATE_IMPORT_MAX_ROWS = 1000;

export const RATE_IMPORT_MESSAGES = {
  RATE_IMPORT_EMPTY: "The rates file has no rows to save.",
  RATE_IMPORT_TOO_MANY_ROWS: "A rates file can hold at most 1000 rows.",
  RATE_IMPORT_INVALID_ROW: "A row of the rates file is invalid.",
  RATE_IMPORT_FUTURE_DATE: "A rate cannot be dated after the company's business date.",
  RATE_IMPORT_DUPLICATE_ROW: "The rates file holds the same currency and date twice.",
  RATE_IMPORT_CONFLICT:
    "Some rows differ from the rate already recorded on their date. Review them and confirm that they replace it.",
} as const;

export type RateImportRefusalCode = keyof typeof RATE_IMPORT_MESSAGES;

export class RateImportRefusal extends Error {
  constructor(
    readonly code: RateImportRefusalCode,
    readonly rows: Array<Record<string, unknown>> = []
  ) {
    super(RATE_IMPORT_MESSAGES[code]);
    this.name = "RateImportRefusal";
  }

  get status(): number {
    return this.code === "RATE_IMPORT_CONFLICT" ? 409 : 400;
  }

  get body() {
    return { code: this.code, message: this.message, rows: this.rows };
  }
}

export interface RateImportActor extends AuditActor {
  userId: string | number;
  companyId: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function positiveRate(value: unknown, scale: number): string | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!DECIMAL.test(text)) return null;
  const rate = new MoneyDecimal(text);
  if (rate.lte(0) || rate.decimalPlaces() > scale) return null;
  return rate.toFixed();
}

function sameRate(a: unknown, b: string): boolean {
  return new MoneyDecimal(String(a)).eq(new MoneyDecimal(b));
}

function rowsOf(body: unknown): unknown[] {
  const rows = (body as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new RateImportRefusal("RATE_IMPORT_EMPTY");
  if (rows.length > RATE_IMPORT_MAX_ROWS) throw new RateImportRefusal("RATE_IMPORT_TOO_MANY_ROWS");
  return rows;
}

function refuseInvalid(index: number, field: string): never {
  throw new RateImportRefusal("RATE_IMPORT_INVALID_ROW", [{ row: index + 1, field }]);
}

function refuseFutureAndDuplicates<T extends { effectiveDate: string }>(
  rows: T[],
  businessDate: string,
  keyOf: (row: T) => string
): void {
  const future = rows
    .map((row, index) => ({ row: index + 1, effectiveDate: row.effectiveDate }))
    .filter((row) => row.effectiveDate > businessDate);
  if (future.length > 0) {
    throw new RateImportRefusal(
      "RATE_IMPORT_FUTURE_DATE",
      future.map((row) => ({ ...row, businessDate }))
    );
  }
  const seen = new Set<string>();
  const duplicates: Array<Record<string, unknown>> = [];
  rows.forEach((row, index) => {
    const key = keyOf(row);
    if (seen.has(key)) duplicates.push({ row: index + 1, key });
    seen.add(key);
  });
  if (duplicates.length > 0) throw new RateImportRefusal("RATE_IMPORT_DUPLICATE_ROW", duplicates);
}

// ── Factory rates ────────────────────────────────────────────────────────────

export interface FactoryRateImportRow {
  currencyCode: string;
  effectiveDate: string;
  rateToUsd: string;
}

export interface FactoryRateImportResult {
  businessDate: string;
  inserted: Array<FactoryRateImportRow & { id: number; replaced: string | null }>;
  identical: FactoryRateImportRow[];
}

/** Validates the request rows of a factory rates file (nothing is read or written). */
export function parseFactoryRateImportRows(body: unknown): FactoryRateImportRow[] {
  return rowsOf(body).map((raw, index) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const currencyCode = String(entry.currencyCode ?? "")
      .trim()
      .toUpperCase();
    if (!CURRENCY.test(currencyCode) || currencyCode === "USD") refuseInvalid(index, "currencyCode");
    const effectiveDate = String(entry.effectiveDate ?? "").trim();
    if (!isIsoDate(effectiveDate)) refuseInvalid(index, "effectiveDate");
    const rateToUsd = positiveRate(entry.rateToUsd, 8);
    if (rateToUsd === null) refuseInvalid(index, "rateToUsd");
    return { currencyCode, effectiveDate, rateToUsd };
  });
}

/** Saves a factory rates file for one company: every row, and one audit row, in one transaction. */
export async function importFactoryFxRates(
  actor: RateImportActor,
  rows: FactoryRateImportRow[],
  options: { replaceConflicts: boolean }
): Promise<FactoryRateImportResult> {
  const businessDate = await companyBusinessDate(actor.companyId);
  refuseFutureAndDuplicates(rows, businessDate, (row) => `${row.currencyCode}:${row.effectiveDate}`);
  return db.transaction(async (tx) => {
    const currencies = Array.from(new Set(rows.map((row) => row.currencyCode))).sort();
    for (const currency of currencies) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`factory_fx_rates:${actor.companyId}:${currency}`}))`
      );
    }
    const existing = await tx
      .select({
        id: factoryFxRates.id,
        currencyCode: factoryFxRates.currencyCode,
        rateToUsd: factoryFxRates.rateToUsd,
        effectiveDate: factoryFxRates.effectiveDate,
      })
      .from(factoryFxRates)
      .where(
        and(
          eq(factoryFxRates.companyId, actor.companyId),
          eq(factoryFxRates.source, "manual"),
          inArray(factoryFxRates.currencyCode, currencies)
        )
      )
      .orderBy(asc(factoryFxRates.id));
    // The rate in force on a date is the latest manual row saved for it.
    const onDate = new Map<string, string>();
    for (const row of existing) onDate.set(`${row.currencyCode}:${String(row.effectiveDate)}`, String(row.rateToUsd));

    const identical: FactoryRateImportRow[] = [];
    const toInsert: Array<FactoryRateImportRow & { replaced: string | null }> = [];
    const conflicts: Array<Record<string, unknown>> = [];
    rows.forEach((row, index) => {
      const recorded = onDate.get(`${row.currencyCode}:${row.effectiveDate}`);
      if (recorded === undefined) toInsert.push({ ...row, replaced: null });
      else if (sameRate(recorded, row.rateToUsd)) identical.push(row);
      else {
        conflicts.push({ row: index + 1, ...row, recorded });
        toInsert.push({ ...row, replaced: recorded });
      }
    });
    if (conflicts.length > 0 && !options.replaceConflicts)
      throw new RateImportRefusal("RATE_IMPORT_CONFLICT", conflicts);

    const inserted: FactoryRateImportResult["inserted"] = [];
    for (const row of toInsert) {
      const [saved] = await tx
        .insert(factoryFxRates)
        .values({
          companyId: actor.companyId,
          currencyCode: row.currencyCode,
          rateToUsd: row.rateToUsd,
          effectiveDate: row.effectiveDate,
          source: "manual",
        })
        .returning({ id: factoryFxRates.id });
      inserted.push({ ...row, id: saved.id });
    }
    if (inserted.length > 0) await auditImport(tx, actor, "factory_fx_rates", inserted, identical.length);
    return { businessDate, inserted, identical };
  });
}

// ── Company rates ────────────────────────────────────────────────────────────

export interface CompanyRateImportRow {
  fromCurrency: string;
  toCurrency: string;
  effectiveDate: string;
  rate: string;
}

export interface CompanyRateImportResult {
  businessDate: string;
  inserted: Array<CompanyRateImportRow & { id: number; replaced: string | null }>;
  identical: CompanyRateImportRow[];
}

/** Validates the request rows of a company rates file (nothing is read or written). */
export function parseCompanyRateImportRows(body: unknown): CompanyRateImportRow[] {
  return rowsOf(body).map((raw, index) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const fromCurrency = String(entry.fromCurrency ?? "")
      .trim()
      .toUpperCase();
    const toCurrency = String(entry.toCurrency ?? "")
      .trim()
      .toUpperCase();
    if (!CURRENCY.test(fromCurrency)) refuseInvalid(index, "fromCurrency");
    if (!CURRENCY.test(toCurrency) || toCurrency === fromCurrency) refuseInvalid(index, "toCurrency");
    const effectiveDate = String(entry.effectiveDate ?? "").trim();
    if (!isIsoDate(effectiveDate)) refuseInvalid(index, "effectiveDate");
    const rate = positiveRate(entry.rate, 6);
    if (rate === null) refuseInvalid(index, "rate");
    return { fromCurrency, toCurrency, effectiveDate, rate };
  });
}

/** Saves a company rates file: every row, and one audit row, in one transaction. */
export async function importCompanyExchangeRates(
  actor: RateImportActor,
  rows: CompanyRateImportRow[],
  options: { replaceConflicts: boolean }
): Promise<CompanyRateImportResult> {
  const businessDate = await companyBusinessDate(actor.companyId);
  refuseFutureAndDuplicates(rows, businessDate, (row) => `${row.fromCurrency}:${row.toCurrency}:${row.effectiveDate}`);
  return db.transaction(async (tx) => {
    const keys = Array.from(
      new Set(rows.map((row) => `${row.effectiveDate}:${row.fromCurrency}:${row.toCurrency}`))
    ).sort();
    // The same lock as a single save of that company, date and pair.
    for (const key of keys) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`exchange_rates:${actor.companyId}:${key}`}))`);
    }
    const dates = Array.from(new Set(rows.map((row) => row.effectiveDate)));
    const existing = await tx
      .select()
      .from(exchangeRates)
      .where(and(eq(exchangeRates.companyId, actor.companyId), inArray(exchangeRates.effectiveDate, dates)))
      .orderBy(asc(exchangeRates.id));
    const onDate = new Map<string, { id: number; rate: string }>();
    for (const row of existing) {
      const key = `${String(row.effectiveDate)}:${row.fromCurrency}:${row.toCurrency}`;
      if (!onDate.has(key)) onDate.set(key, { id: row.id, rate: String(row.rate) });
    }

    const identical: CompanyRateImportRow[] = [];
    const conflicts: Array<Record<string, unknown>> = [];
    const writes: Array<CompanyRateImportRow & { existingId: number | null; replaced: string | null }> = [];
    rows.forEach((row, index) => {
      const recorded = onDate.get(`${row.effectiveDate}:${row.fromCurrency}:${row.toCurrency}`);
      if (!recorded) writes.push({ ...row, existingId: null, replaced: null });
      else if (sameRate(recorded.rate, row.rate)) identical.push(row);
      else {
        conflicts.push({ row: index + 1, ...row, recorded: recorded.rate });
        writes.push({ ...row, existingId: recorded.id, replaced: recorded.rate });
      }
    });
    if (conflicts.length > 0 && !options.replaceConflicts)
      throw new RateImportRefusal("RATE_IMPORT_CONFLICT", conflicts);

    const inserted: CompanyRateImportResult["inserted"] = [];
    for (const { existingId, ...row } of writes) {
      const [saved] =
        existingId === null
          ? await tx
              .insert(exchangeRates)
              .values({ ...row, companyId: actor.companyId })
              .returning({ id: exchangeRates.id })
          : await tx
              .update(exchangeRates)
              .set({ rate: row.rate })
              .where(and(eq(exchangeRates.id, existingId), eq(exchangeRates.companyId, actor.companyId)))
              .returning({ id: exchangeRates.id });
      inserted.push({ ...row, id: saved.id });
    }
    if (inserted.length > 0) await auditImport(tx, actor, "exchange_rates", inserted, identical.length);
    return { businessDate, inserted, identical };
  });
}

async function auditImport<T extends { replaced: string | null }>(
  tx: DbTransaction,
  actor: RateImportActor,
  tableName: "factory_fx_rates" | "exchange_rates",
  saved: T[],
  identicalCount: number
): Promise<void> {
  await writeAuditEvent(
    {
      ...actor,
      action: "create",
      tableName,
      recordIdentifier: `rates-file-import:${saved.length}`,
      changes: {
        rates: {
          old: saved.filter((row) => row.replaced !== null),
          new: saved.map(({ replaced: _replaced, ...row }) => row),
        },
        identicalRowsSkipped: { old: null, new: identicalCount },
      },
    },
    tx
  );
}
