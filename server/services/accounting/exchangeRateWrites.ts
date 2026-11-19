/**
 * Exchange-rate saves (accounting audit wave 14, owner decision 2).
 *
 * A rate decides the USD value of every later foreign-currency posting, so
 * changing a rate is restricted to Admin/Owner (and Developer) at the route
 * (any other writing role may only set or change today's company rate), and every
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
import { factoryFxRates, type FactoryFxRate } from "@shared/schema";

import { db } from "../../db";
import { writeAuditEvent } from "../audit";
import { fetchExternalFactoryFxRate } from "../factory/factoryFxRateReadOnly";
import type { RateActor } from "./saveCompanyExchangeRate";
import {
  documentDatesForCurrency,
  type KeptFactoryFxRate,
  type DeleteFactoryFxRatesResult,
  type FetchedFactoryRateInput,
} from "./exchangeRateWritesDocumentDatesForCurrency";
export type {
  KeptFactoryFxRateReason,
  KeptFactoryFxRate,
  DeleteFactoryFxRatesResult,
  FetchedFactoryRateInput,
} from "./exchangeRateWritesDocumentDatesForCurrency";
export { saveCompanyExchangeRate, saveFactoryFxRate } from "./saveCompanyExchangeRate";
export type { CompanyRateInput, FactoryRateInput, RateActor } from "./saveCompanyExchangeRate";

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
        kept.push({ ...shape, reason: row.source === "archived" ? "archived_rate" : "recorded_auto_rate" });
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

/**
 * Removes exactly one settings row. Rates that may have priced an existing
 * document are retained in the database as archived evidence instead of
 * being destroyed. Archived rows are not candidates for new FX lookups or
 * the editable settings list. No posted voucher, sale or daybook is changed.
 *
 * The legacy currency-wide delete is deliberately left unchanged for older
 * callers. The settings UI uses only this ID-based endpoint.
 */
export async function removeFactoryFxRateById(
  actor: RateActor,
  rateId: number
): Promise<{ id: number; currencyCode: string; effectiveDate: string; archived: boolean } | null> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(factoryFxRates)
      .where(
        and(
          eq(factoryFxRates.id, rateId),
          eq(factoryFxRates.companyId, actor.companyId),
          eq(factoryFxRates.source, "manual")
        )
      )
      .limit(1);
    if (!candidate) return null;

    // Coordinate with inserts, currency deletes and other single-row removals.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`factory_fx_rates:${actor.companyId}:${candidate.currencyCode}`}))`
    );
    const [row] = await tx
      .select()
      .from(factoryFxRates)
      .where(
        and(
          eq(factoryFxRates.id, rateId),
          eq(factoryFxRates.companyId, actor.companyId),
          eq(factoryFxRates.source, "manual")
        )
      )
      .limit(1)
      .for("update");
    if (!row) return null;

    const manualDates = await tx
      .select({ effectiveDate: factoryFxRates.effectiveDate })
      .from(factoryFxRates)
      .where(
        and(
          eq(factoryFxRates.companyId, actor.companyId),
          eq(factoryFxRates.currencyCode, row.currencyCode),
          eq(factoryFxRates.source, "manual")
        )
      )
      .orderBy(asc(factoryFxRates.effectiveDate));
    const date = String(row.effectiveDate);
    const next = manualDates.map((r) => String(r.effectiveDate)).find((d) => d > date);
    // Treat same-day duplicates conservatively: an older ID could have priced
    // a document before a newer rate was created on the same date.
    const documentDates = await documentDatesForCurrency(tx, actor.companyId, row.currencyCode);
    const used = documentDates.some((d) => d >= date && (!next || d < next));

    if (used) {
      await tx
        .update(factoryFxRates)
        .set({ source: "archived" })
        .where(and(eq(factoryFxRates.id, rateId), eq(factoryFxRates.companyId, actor.companyId)));
    } else {
      await tx
        .delete(factoryFxRates)
        .where(and(eq(factoryFxRates.id, rateId), eq(factoryFxRates.companyId, actor.companyId)));
    }

    await writeAuditEvent(
      {
        ...actor,
        action: used ? "update" : "delete",
        tableName: "factory_fx_rates",
        recordId: row.id,
        recordIdentifier: `${row.currencyCode} ${date} #${row.id}`,
        changes: {
          source: { old: "manual", new: used ? "archived" : null },
          rateToUsd: { old: String(row.rateToUsd), new: used ? String(row.rateToUsd) : null },
          reason: { new: used ? "archived_rate_with_document_history" : "removed_unused_settings_rate" },
        },
      },
      tx
    );
    return { id: row.id, currencyCode: row.currencyCode, effectiveDate: date, archived: used };
  });
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
