/** Shared helpers of the factory advance routes (split out of advanceManagementRoutes.ts). */

import { db } from "../../db";
import { factoryDaybookEntries } from "@shared/schema";
import { daybookAmountUsd } from "../../lib/money";

/** Prefer the factory-pinned company ID so cross-tab ERP company switches don't corrupt factory writes. */
export function getFactoryCompanyId(req: import("express").Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

/** Write a single daybook entry (factory audit log). */
export async function writeDaybookEntry(
  dbOrTx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  opts: {
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
  }
) {
  const currency = opts.currencyCode || "USD";
  const fxRate = opts.fxRateToUsd || 1;
  const amtCurrency = opts.amountCurrency || 0;
  const amtUsd = daybookAmountUsd(currency, amtCurrency, fxRate, opts.amountUsd);
  await dbOrTx.insert(factoryDaybookEntries).values({
    companyId: opts.companyId,
    txDate: opts.txDate,
    txType: opts.txType,
    referenceId: opts.referenceId || null,
    referenceTable: opts.referenceTable || null,
    description: opts.description,
    metaJson: opts.metaJson || null,
    currencyCode: currency,
    amountCurrency: String(amtCurrency),
    fxRateToUsd: String(fxRate),
    amountUsd: amtUsd,
    createdBy: opts.createdBy || null,
  });
}
