/**
 * Supplier FX transfer accounting. User-entered historic FX rates may express
 * either USD/foreign or foreign/USD. Never overwrite the source exchange rate.
 * Transfer's recorded USD settlement is the financial control total.
 *
 * Supplier settlement: DR source supplier in source currency, CR destination
 * supplier in USD. Both legs carry the same USD base, so total company payable
 * remains unchanged. Rounding difference from a 10dp stored rate goes to the
 * dedicated Rounding Differences ledger account at 6dp precision.
 *
 * Commission allocation already represented by direct FACTORY-COMM vouchers
 * is NOT a second financial event. It must not be posted to NASRA again.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { postFactoryVoucherTx } from "./factoryVoucherPosting";

const COMPANY_ROUNDING_CODE = "ROUNDING";
const ZERO = new MoneyDecimal(0);

export interface SupplierFxJournalDocument {
  id: number;
  companyId: number;
  date: string;
  fromSupplierId: number;
  toSupplierId: number;
  sourceType: string | null;
  fromCurrencyCode: string;
  fromAmount: string;
  fxRateToUsd: string;
  toAmountUsd: string;
}

export function describeSupplierFxConversion(document: SupplierFxJournalDocument) {
  const from = toMoney(document.fromAmount);
  const usd = toMoney(document.toAmountUsd);
  const entered = toMoney(document.fxRateToUsd);
  const currency = document.fromCurrencyCode.trim().toUpperCase();

  if (from.lte(0) || usd.lte(0) || entered.lte(0) || !["EUR", "AUD", "USD", "CDF", "CFA"].includes(currency)) {
    throw new Error(`Invalid FX transfer amounts, currency or rate #${document.id}`);
  }
  const mul = from.times(entered);
  const div = from.div(entered);
  const convention = mul.minus(usd).abs().lte(div.minus(usd).abs()) ? "multiply" : "divide";
  const best = convention === "multiply" ? mul : div;
  const acceptableDeviation = MoneyDecimal.max("0.05", usd.times("0.00001"));
  if (best.minus(usd).abs().gt(acceptableDeviation)) {
    throw new Error(`FX transfer #${document.id} has an inconsistent stored rate and USD settlement; review required`);
  }
  if (currency === "USD" && (!entered.eq(1) || !from.minus(usd).abs().lte("0.005"))) {
    throw new Error(`USD transfer #${document.id} must have rate 1.0 and equal source/destination`);
  }

  // Use the user's recorded amounts (not a new or today's FX rate). An
  // effective USD-per-native unit rate at 10dp reproduces the USD settlement.
  // The original rate and its multiply/divide convention remain on the source.
  const postingUsdPerUnit = usd.div(from).toDecimalPlaces(10);
  const convertedDebit = from.toDecimalPlaces(6).times(postingUsdPerUnit).toDecimalPlaces(6);
  const residual = usd.minus(convertedDebit).toDecimalPlaces(6);
  if (residual.abs().gt("0.005")) throw new Error(`Transfer #${document.id} rounding exceeds 0.005 USD`);
  return { convention, currency, from, usd, entered, postingUsdPerUnit, residual };
}

export async function assertCommissionAllocationCoveredTx(
  tx: DbTransaction,
  companyId: number,
  document: SupplierFxJournalDocument
): Promise<void> {
  if (document.sourceType !== "commission") throw new Error("Not a commission allocation");
  const coverage = await tx.execute(sql`
    SELECT COALESCE(SUM(ve.credit_amount), 0)::text AS posted_credits
      FROM factory_containers fc
      JOIN vouchers v ON v.company_id = fc.company_id
        AND v.deleted_at IS NULL AND v.optional = false
        AND (v.voucher_number = 'FACTORY-COMM-' || fc.id::text
          OR v.voucher_number LIKE 'FACTORY-COMM-' || fc.id::text || '-%')
      JOIN voucher_entries ve ON ve.voucher_id = v.id
        AND ve.factory_supplier_id = ${document.toSupplierId}
        AND ve.credit_amount > 0
     WHERE fc.company_id = ${companyId}
       AND fc.supplier_id = ${document.fromSupplierId}
       AND fc.commission_supplier_id = ${document.toSupplierId}
       AND fc.deleted_at IS NULL
  `);
  const sum = toMoney(coverage.rows[0]?.posted_credits as string);
  const claimed = await tx.execute(sql`
    SELECT COALESCE(SUM(to_amount_usd), 0)::text AS amount
      FROM factory_supplier_fx_transfers
     WHERE company_id = ${companyId} AND source_type = 'commission'
       AND from_supplier_id = ${document.fromSupplierId}
       AND to_supplier_id = ${document.toSupplierId}
  `);
  if (sum.lt(toMoney(claimed.rows[0]?.amount as string))) {
    throw new Error(
      `Commission transfer #${document.id} is not covered by existing payable vouchers: refusing to create a duplicate or unbacked liability`
    );
  }
}

export async function postSupplierFxTransferJournalTx(
  tx: DbTransaction,
  document: SupplierFxJournalDocument
): Promise<{ voucherId: number; replayed: boolean }> {
  if (document.sourceType !== "supplier" && document.sourceType !== null) {
    throw new Error(`Unsupported financial supplier FX transfer kind #${document.id}`);
  }
  const amounts = describeSupplierFxConversion(document);
  const rounding = await tx.execute(sql`
    SELECT id FROM ledger_accounts
     WHERE company_id = ${document.companyId} AND code = ${COMPANY_ROUNDING_CODE}
       AND deleted_at IS NULL LIMIT 2
  `);
  if (rounding.rows.length !== 1) throw new Error("Unique company rounding ledger account required");
  const lines: Array<{
    factorySupplierId?: number;
    ledgerAccountId?: number;
    currency?: string;
    fxRateToUsd?: string;
    debit?: string;
    credit?: string;
    narration?: string;
  }> = [
    {
      factorySupplierId: document.fromSupplierId,
      currency: amounts.currency,
      fxRateToUsd: amounts.postingUsdPerUnit.toFixed(10),
      debit: amounts.from.toFixed(4),
      narration: `FX transfer #${document.id}: reduce payable ${amounts.from.toFixed(4)} ${amounts.currency}; stored rate ${amounts.entered.toString()} (${amounts.convention})`,
    },
    {
      factorySupplierId: document.toSupplierId,
      currency: "USD",
      credit: amounts.usd.toFixed(4),
      narration: `FX transfer #${document.id}: create USD payable from ${amounts.currency}`,
    },
  ];
  if (amounts.residual.abs().gt(ZERO)) {
    lines.push({
      ledgerAccountId: Number(rounding.rows[0].id),
      currency: "USD",
      ...(amounts.residual.gt(0)
        ? { debit: amounts.residual.toFixed(6) }
        : { credit: amounts.residual.abs().toFixed(6) }),
      narration: `Sub-cent settlement FX precision #${document.id}`,
    });
  }

  const result = await postFactoryVoucherTx(tx, {
    companyId: document.companyId,
    voucherType: "Journal",
    voucherNumber: (generation) => `FACTORY-SFX-${document.id}-${generation}`,
    voucherDate: document.date,
    description: `Factory supplier FX transfer #${document.id}: ${amounts.from.toFixed(4)} ${amounts.currency} → ${amounts.usd.toFixed(4)} USD (stored ${amounts.entered.toString()}, ${amounts.convention})`,
    currency: "USD",
    fxRateToUsd: "1",
    source: { sourceType: "factory-supplier-fx-transfer", sourceId: document.id, phase: "settlement" },
    lines,
  });
  return { voucherId: result.voucher.id, replayed: result.replayed };
}
