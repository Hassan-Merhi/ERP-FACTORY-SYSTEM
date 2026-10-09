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
 *     would have used); a delete removes every row of the currency (old = the
 *     removed rows).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { exchangeRates, factoryFxRates, type ExchangeRate, type FactoryFxRate } from "@shared/schema";

import { db } from "../../db";
import { writeAuditEvent, type AuditActor } from "../audit";
import { storedFactoryFxRateOnOrBefore } from "../factory/factoryFxRateOnDate";

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

/** Removes every rate of one factory currency, with its audit, in one transaction. */
export async function deleteFactoryFxRates(actor: RateActor, currencyCode: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`factory_fx_rates:${actor.companyId}:${currencyCode}`}))`
    );
    const removed = await tx
      .delete(factoryFxRates)
      .where(and(eq(factoryFxRates.companyId, actor.companyId), eq(factoryFxRates.currencyCode, currencyCode)))
      .returning();
    if (removed.length > 0) {
      await writeAuditEvent(
        {
          ...actor,
          action: "delete",
          tableName: "factory_fx_rates",
          recordIdentifier: currencyCode,
          // "lines" keeps every removed row in the audit (FULL_SNAPSHOT_AUDIT_FIELDS).
          changes: {
            lines: {
              old: removed.map((row) => ({
                id: row.id,
                rate: String(row.rateToUsd),
                effectiveDate: String(row.effectiveDate),
                source: row.source,
              })),
              new: null,
            },
          },
        },
        tx
      );
    }
    return removed.length;
  });
}
