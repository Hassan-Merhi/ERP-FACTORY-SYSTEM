/**
 * The one factory daybook writer (accounting audit phase 19 C, M3).
 *
 * Before: eight copies of `writeDaybookEntry` (factory, factory payroll,
 * factory workers, factory reports and four payroll route groups). Seven of
 * them stored a non-USD entry written without a rate at rate 1, so its native
 * amount was read as USD.
 *
 * Now every route group re-exports this writer. A non-USD entry written
 * without a rate takes the company's confirmed factory rate dated on or before
 * its date (`findFactoryFxRateOnOrBefore`: manual, else recorded auto); with
 * none it is stored unresolved — rate 0 and amount_usd 0, as
 * `resolveStoredFxRate` reads it — and logged, never at rate 1. A USD entry is
 * at rate 1. An explicit `amountUsd` is stored as given.
 */
import { factoryDaybookEntries } from "@shared/schema";

import type { DatabaseOrTransaction } from "../../db";
import { logger } from "../../lib/logger";
import { daybookAmountUsd, toMoney } from "../../lib/money";
import { resolveStoredFxRate } from "./currencyConversion";
import { AUTO_FILL_REF_TABLE } from "./daybookSourceIntegrity";
import { findFactoryFxRateOnOrBefore } from "./factoryFxRateOnDate";

export interface FactoryDaybookEntryInput {
  companyId: number;
  txDate: string;
  txType: string;
  referenceId?: number;
  referenceTable?: string;
  description: string;
  metaJson?: string;
  currencyCode?: string;
  amountCurrency?: number;
  fxRateToUsd?: number;
  amountUsd?: number;
  createdBy?: string | null;
  effectiveDate?: string | null;
}

/** The rate a daybook entry is stored at: 1 for USD, the given rate, the dated confirmed rate, else 0 (unresolved). */
export async function factoryDaybookRate(
  executor: DatabaseOrTransaction,
  opts: Pick<FactoryDaybookEntryInput, "companyId" | "txDate" | "currencyCode" | "fxRateToUsd" | "amountUsd">
): Promise<number> {
  const currency = opts.currencyCode || "USD";
  if (currency === "USD") return 1;
  const given = opts.fxRateToUsd || 0;
  if (given > 0 || opts.amountUsd !== undefined) return given > 0 ? given : 0;
  const dated = await findFactoryFxRateOnOrBefore(executor, opts.companyId, currency, opts.txDate);
  return dated ? toMoney(dated.rate).toNumber() : 0;
}

export async function writeDaybookEntry(dbOrTx: DatabaseOrTransaction, opts: FactoryDaybookEntryInput) {
  const currency = opts.currencyCode || "USD";
  const amtCurrency = opts.amountCurrency || 0;
  const fxRate = await factoryDaybookRate(dbOrTx, opts);
  const { looksSet } = resolveStoredFxRate(currency, fxRate);
  if (!looksSet && currency !== "USD") {
    logger.warn(
      `[writeDaybookEntry] Unresolved exchange rate for ${currency} on txType=${opts.txType} companyId=${opts.companyId} — stored unresolved (rate 0)`
    );
  }
  const amtUsd =
    currency !== "USD" && !(fxRate > 0) && opts.amountUsd === undefined
      ? "0"
      : daybookAmountUsd(currency, amtCurrency, fxRate, opts.amountUsd);
  const [inserted] = await dbOrTx
    .insert(factoryDaybookEntries)
    .values({
      companyId: opts.companyId,
      txDate: opts.txDate,
      txType: opts.txType,
      referenceId: opts.referenceId ?? null,
      referenceTable:
        opts.referenceTable ?? (opts.referenceId != null ? (AUTO_FILL_REF_TABLE[opts.txType] ?? null) : null),
      description: opts.description,
      metaJson: opts.metaJson || null,
      currencyCode: currency,
      amountCurrency: String(amtCurrency),
      fxRateToUsd: String(fxRate),
      amountUsd: amtUsd,
      createdBy: opts.createdBy || null,
      effectiveDate: opts.effectiveDate || null,
    })
    .returning({ id: factoryDaybookEntries.id });
  return inserted; // { id: number } — callers that ignore the return value continue to work
}
