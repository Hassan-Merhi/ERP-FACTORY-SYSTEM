// Extracted from ./exchangeRateWrites.ts to keep that module under the source-size cap.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { datedMonetaryRateTx, MonetaryFxError } from "./monetaryFxRates";
import { type ExchangeRate, exchangeRates, type FactoryFxRate, factoryFxRates } from "@shared/schema";
import { db } from "../../db";
import { type AuditActor, writeAuditEvent } from "../audit";
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
    const sameDayRows = await tx.select().from(exchangeRates).where(match).orderBy(asc(exchangeRates.id)).limit(2);
    // Some deployments predate the unique index. Updating the earliest row
    // while the latest (highest id) controls reporting looks like a successful
    // save that never changes the USD balances. Fail closed until reconciled.
    if (sameDayRows.length > 1) {
      throw new MonetaryFxError(
        "FX_RATE_DUPLICATE_ROWS",
        "More than one rate exists for this company/date/pair. Reconcile the duplicate rates before saving.",
        409
      );
    }
    const [existing] = sameDayRows;
    // A repeated submission of the same numerical rate is not a new revision.
    // Do not rewrite the row or create another audit event for a no-op.
    if (existing && new Decimal(String(existing.rate)).eq(new Decimal(input.rate))) {
      // A no-op rate must not disguise a conflicting reverse-direction
      // rate already stored for that day.
      if (input.fromCurrency === "USD") {
        await datedMonetaryRateTx(tx, actor.companyId, input.toCurrency, input.effectiveDate);
      }
      return existing;
    }
    const [saved] = existing
      ? await tx.update(exchangeRates).set({ rate: input.rate }).where(eq(exchangeRates.id, existing.id)).returning()
      : await tx
          .insert(exchangeRates)
          .values({ ...input, companyId: actor.companyId })
          .returning();
    // A stored opposite-direction quote on this business date must agree.
    // Reject and roll back both the rate save and its audit rather than
    // recording a successful rate that the read-time resolver rejects.
    if (input.fromCurrency === "USD") {
      await datedMonetaryRateTx(tx, actor.companyId, input.toCurrency, input.effectiveDate);
    }
    await writeAuditEvent(
      {
        ...actor,
        action: existing ? "update" : "create",
        tableName: "exchange_rates",
        recordId: saved.id,
        recordIdentifier: `${input.fromCurrency}/${input.toCurrency} ${input.effectiveDate}`,
        changes: {
          rate: { old: existing ? String(existing.rate) : null, new: String(saved.rate) },
          effectiveDate: { old: existing ? String(existing.effectiveDate) : null, new: input.effectiveDate },
          pair: {
            old: existing ? `${existing.fromCurrency}/${existing.toCurrency}` : null,
            new: `${input.fromCurrency}/${input.toCurrency}`,
          },
          // This is a reporting-rate amendment only. Original voucher rates
          // and foreign-currency balances are not changed.
          valuationScope: { new: "CURRENT_MANAGEMENT_USD_ONLY" },
        },
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
    // Keep one active manual rate per currency and effective date. Previous
    // same-day revisions remain archived evidence rather than being overwritten
    // or deleted (documents may have used their exact original value).
    const sameDay = await tx
      .select()
      .from(factoryFxRates)
      .where(
        and(
          eq(factoryFxRates.companyId, actor.companyId),
          eq(factoryFxRates.currencyCode, input.currencyCode),
          eq(factoryFxRates.effectiveDate, input.effectiveDate),
          eq(factoryFxRates.source, "manual")
        )
      )
      .orderBy(asc(factoryFxRates.id))
      .for("update");
    const latest = sameDay[sameDay.length - 1];
    if (sameDay.length === 1 && latest && String(latest.rateToUsd) === Number(input.rateToUsd).toFixed(8)) {
      return latest; // Repeated save of an identical rate is idempotent.
    }
    if (sameDay.length > 0) {
      await tx
        .update(factoryFxRates)
        .set({ source: "archived" })
        .where(
          and(
            eq(factoryFxRates.companyId, actor.companyId),
            inArray(
              factoryFxRates.id,
              sameDay.map((row) => row.id)
            )
          )
        );
    }
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
          archivedSameDay: { old: sameDay.map((row) => ({ id: row.id, rate: String(row.rateToUsd) })), new: [] },
        },
      },
      tx
    );
    return saved;
  });
}
