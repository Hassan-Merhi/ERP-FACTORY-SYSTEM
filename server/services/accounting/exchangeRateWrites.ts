/**
 * Exchange-rate saves (accounting audit wave 14, owner decision 2).
 *
 * A rate decides the USD value of every later foreign-currency posting, so a
 * save is restricted to Admin/Owner (and Developer) at the route, and every
 * save, change or delete writes its audit row, with the old and the new value,
 * in the same transaction as the rate itself: a rate never changes without its
 * audit, and an audit never records a change that did not commit.
 *
 *   - Company rates (`exchange_rates`, POST /api/exchange-rates): one row per
 *     company, date and currency pair; a save on the same date replaces the
 *     rate (old = the replaced rate, or null for a new date).
 *   - Factory rates (`factory_fx_rates`, POST/DELETE /api/factory/fx-rates):
 *     a save adds a manual rate effective from its date (old = the manual rate
 *     that applied on that date before the save, the one factory postings
 *     would have used); a delete removes only the manual rates no document
 *     used (wave 17 C, deleteFactoryFxRates) and reports the rows it kept;
 *     a fetched external rate is recorded (auto) only by saveFetchedFactoryFxRate.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { exchangeRates, factoryFxRates, type ExchangeRate, type FactoryFxRate } from "@shared/schema";

import { db, type DbTransaction } from "../../db";
import { writeAuditEvent, type AuditActor } from "../audit";
import { storedFactoryFxRateOnOrBefore } from "../factory/factoryFxRateOnDate";
import { fetchExternalFactoryFxRate } from "../factory/factoryFxRateReadOnly";

export interface RateActor extends AuditActor {
  userId: string | number;
  companyId: number;
}

export interface CompanyRateInput {
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  effectiveDate: string;
}

/** Saves the company rate for its date and pair, with its audit, in one transaction. */
export async function saveCompanyExchangeRate(actor: RateActor, input: CompanyRateInput): Promise<ExchangeRate> {
  return db.transaction(async (tx) => {
    // Serialises saves of one company/date/pair (the unique index may be absent
    // where startup migrations are off), so "old" is the row this save replaces.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`exchange_rates:${actor.companyId}:${input.effectiveDate}:${input.fromCurrency}:${input.toCurrency}`}))`
    );
    const match = and(
      eq(exchangeRates.companyId, actor.companyId),
      eq(exchangeRates.effectiveDate, input.effectiveDate),
      eq(exchangeRates.fromCurrency, input.fromCurrency),
      eq(exchangeRates.toCurrency, input.toCurrency)
    );
    const [existing] = await tx.select().from(exchangeRates).where(match).orderBy(asc(exchangeRates.id)).limit(1);
    const [saved] = existing
      ? await tx.update(exchangeRates).set({ rate: input.rate }).where(eq(exchangeRates.id, existing.id)).returning()
      : await tx
          .insert(exchangeRates)
          .values({ ...input, companyId: actor.companyId })
          .returning();
    await writeAuditEvent(
      {
        ...actor,
        action: existing ? "update" : "create",
        tableName: "exchange_rates",
        recordId: saved.id,
        recordIdentifier: `${input.fromCurrency}/${input.toCurrency} ${input.effectiveDate}`,
        changes: { rate: { old: existing ? String(existing.rate) : null, new: String(saved.rate) } },
      },
      tx
    );
    return saved;
  });
}

export interface FactoryRateInput {
  currencyCode: string;
  rateToUsd: string;
  effectiveDate: string;
}

/** Adds a manual factory rate, with its audit, in one transaction. */
export async function saveFactoryFxRate(actor: RateActor, input: FactoryRateInput): Promise<FactoryFxRate> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`factory_fx_rates:${actor.companyId}:${input.currencyCode}`}))`
    );
    const previous = await storedFactoryFxRateOnOrBefore(
      tx,
      actor.companyId,
      input.currencyCode,
      input.effectiveDate,
      "manual"
    );
    const [saved] = await tx
      .insert(factoryFxRates)
      .values({ ...input, companyId: actor.companyId, source: "manual" })
      .returning();
    await writeAuditEvent(
      {
        ...actor,
        action: "create",
        tableName: "factory_fx_rates",
        recordId: saved.id,
        recordIdentifier: `${input.currencyCode} ${input.effectiveDate}`,
        changes: {
          rateToUsd: {
            old: previous ? { rate: previous.rate, effectiveDate: previous.effectiveDate } : null,
            new: { rate: String(saved.rateToUsd), effectiveDate: String(saved.effectiveDate) },
          },
        },
      },
      tx
    );
    return saved;
  });
}

/** Why a factory rate row was kept by a currency delete. */
export type KeptFactoryFxRateReason = "used_by_document" | "recorded_auto_rate";

export interface KeptFactoryFxRate {
  id: number;
  rate: string;
  effectiveDate: string;
  source: string;
  reason: KeptFactoryFxRateReason;
}

export interface DeleteFactoryFxRatesResult {
  removed: number;
  removedRows: { id: number; rate: string; effectiveDate: string; source: string }[];
  kept: KeptFactoryFxRate[];
}

/**
 * The distinct dates (YYYY-MM-DD) of every document of the company in one
 * currency that a dated factory rate may have priced: vouchers (by voucher and
 * effective date, deleted and optional ones included, since they can be
 * restored), voucher lines in that transaction currency, factory POS sales and
 * factory daybook events. Conservative on purpose: a date counts whatever the
 * document's state.
 */
async function documentDatesForCurrency(tx: DbTransaction, companyId: number, currencyCode: string): Promise<string[]> {
  const result = await tx.execute<{ d: string } & Record<string, unknown>>(sql`
    SELECT DISTINCT d::text AS d FROM (
      SELECT v.voucher_date AS d FROM vouchers v
       WHERE v.company_id = ${companyId} AND UPPER(COALESCE(v.currency, 'USD')) = ${currencyCode}
      UNION
      SELECT v.effective_date FROM vouchers v
       WHERE v.company_id = ${companyId} AND UPPER(COALESCE(v.currency, 'USD')) = ${currencyCode}
         AND v.effective_date IS NOT NULL
      UNION
      SELECT COALESCE(v.effective_date, v.voucher_date) FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
       WHERE v.company_id = ${companyId} AND UPPER(ve.transaction_currency) = ${currencyCode}
      UNION
      SELECT s.tx_date FROM factory_pos_sales s
       WHERE s.company_id = ${companyId} AND UPPER(s.currency_code) = ${currencyCode}
      UNION
      SELECT e.tx_date FROM factory_daybook_entries e
       WHERE e.company_id = ${companyId} AND UPPER(e.currency_code) = ${currencyCode}
    ) dates WHERE d IS NOT NULL
  `);
  return (result.rows as unknown as { d: string }[]).map((row) => String(row.d).slice(0, 10));
}

/**
 * Deletes the rates of one factory currency that no document used, with its
 * audit, in one transaction (wave 17 C, owner decision 2). Only manual rates
 * are removed, and only those no document can have been priced at:
 *
 *   - a manual rate dated D is "used" when some document of the currency
 *     (documentDatesForCurrency) is dated on or after D and before the next
 *     later manual rate's date (the span in which D is the dated manual rate
 *     on or before the document); several manual rates on the same date share
 *     that span, so all of them are kept;
 *   - a recorded auto rate is always kept: the factory's confirmed-rate rule
 *     (manual, else recorded auto, on or before the date) and the wave 6
 *     repair may have priced a document at it;
 *   - a future-dated manual rate is removed unless a (future-dated) document
 *     falls in its span.
 *
 * The audit row lists every removed row and every kept one with its reason;
 * the result says the same to the caller.
 */
export async function deleteFactoryFxRates(
  actor: RateActor,
  currencyCode: string
): Promise<DeleteFactoryFxRatesResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`factory_fx_rates:${actor.companyId}:${currencyCode}`}))`
    );
    const rows = await tx
      .select()
      .from(factoryFxRates)
      .where(and(eq(factoryFxRates.companyId, actor.companyId), eq(factoryFxRates.currencyCode, currencyCode)))
      .orderBy(asc(factoryFxRates.effectiveDate), asc(factoryFxRates.id))
      .for("update");
    const documentDates = await documentDatesForCurrency(tx, actor.companyId, currencyCode);
    const manualDates = [
      ...new Set(rows.filter((row) => row.source === "manual").map((row) => String(row.effectiveDate))),
    ].sort();

    const kept: KeptFactoryFxRate[] = [];
    const removable: typeof rows = [];
    for (const row of rows) {
      const date = String(row.effectiveDate);
      const shape = { id: row.id, rate: String(row.rateToUsd), effectiveDate: date, source: row.source };
      if (row.source !== "manual") {
        kept.push({ ...shape, reason: "recorded_auto_rate" });
        continue;
      }
      const next = manualDates.find((candidate) => candidate > date);
      const used = documentDates.some((documentDate) => documentDate >= date && (!next || documentDate < next));
      if (used) kept.push({ ...shape, reason: "used_by_document" });
      else removable.push(row);
    }

    const removed = removable.length
      ? await tx
          .delete(factoryFxRates)
          .where(
            and(
              eq(factoryFxRates.companyId, actor.companyId),
              inArray(
                factoryFxRates.id,
                removable.map((row) => row.id)
              )
            )
          )
          .returning()
      : [];
    const removedRows = removed.map((row) => ({
      id: row.id,
      rate: String(row.rateToUsd),
      effectiveDate: String(row.effectiveDate),
      source: row.source,
    }));
    if (removedRows.length > 0 || kept.length > 0) {
      await writeAuditEvent(
        {
          ...actor,
          action: "delete",
          tableName: "factory_fx_rates",
          recordIdentifier: currencyCode,
          // "lines" keeps every removed row in the audit (FULL_SNAPSHOT_AUDIT_FIELDS).
          // writeAuditEvent keeps `metadata` only without `changes`, so the kept rows are a change field.
          changes: { lines: { old: removedRows, new: null }, keptRows: { new: kept } },
        },
        tx
      );
    }
    return { removed: removedRows.length, removedRows, kept };
  });
}

export interface FetchedFactoryRateInput {
  currencyCode: string;
  effectiveDate: string;
}

/**
 * Saves the external historical rate for a date as a recorded (auto) factory
 * rate, with its audit, in one transaction (wave 17 C, owner decision 1). The
 * server fetches the rate itself (`fetchRate`, the frankfurter lookup by
 * default), so the stored value is the external rate, never a client figure.
 * When a rate is already recorded for that exact date it is returned as is
 * and nothing is written (`created: false`). Admin/Owner only, at the route.
 */
export async function saveFetchedFactoryFxRate(
  actor: RateActor,
  input: FetchedFactoryRateInput,
  fetchRate: (currencyCode: string, dateISO: string) => Promise<string> = fetchExternalFactoryFxRate
): Promise<{ rate: FactoryFxRate; created: boolean }> {
  const fetched = await fetchRate(input.currencyCode, input.effectiveDate);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`factory_fx_rates:${actor.companyId}:${input.currencyCode}`}))`
    );
    const [existing] = await tx
      .select()
      .from(factoryFxRates)
      .where(
        and(
          eq(factoryFxRates.companyId, actor.companyId),
          eq(factoryFxRates.currencyCode, input.currencyCode),
          eq(factoryFxRates.effectiveDate, input.effectiveDate),
          eq(factoryFxRates.source, "auto")
        )
      )
      .orderBy(asc(factoryFxRates.id))
      .limit(1);
    if (existing) return { rate: existing, created: false };
    const [saved] = await tx
      .insert(factoryFxRates)
      .values({
        companyId: actor.companyId,
        currencyCode: input.currencyCode,
        rateToUsd: fetched,
        effectiveDate: input.effectiveDate,
        source: "auto",
      })
      .returning();
    await writeAuditEvent(
      {
        ...actor,
        action: "create",
        tableName: "factory_fx_rates",
        recordId: saved.id,
        recordIdentifier: `${input.currencyCode} ${input.effectiveDate} (fetched)`,
        changes: {
          rateToUsd: {
            old: null,
            new: { rate: String(saved.rateToUsd), effectiveDate: String(saved.effectiveDate), source: "auto" },
          },
        },
      },
      tx
    );
    return { rate: saved, created: true };
  });
}
