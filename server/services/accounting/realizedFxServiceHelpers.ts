// Extracted from ./realizedFxService.ts
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { MonetaryFxError } from "./monetaryFxRates";

export type Domain = "customer" | "supplier" | "factory_supplier";

interface MatchedRow extends Record<string, unknown> {
  id: number;
  company_id: number;
  domain: Domain;
  party_id: number;
  amount: string;
  currency: string;
  applied_on: string;
  voided_at: string | null;
  charge_entry_id: number;
  settlement_entry_id: number;
  charge_voucher_id: number;
  settlement_voucher_id: number;
  charge_voucher: string;
  settlement_voucher: string;
  charge_module: string | null;
  settlement_module: string | null;
  charge_deleted: string | null;
  settlement_deleted: string | null;
  charge_optional: boolean;
  settlement_optional: boolean;
  charge_date: string;
  settlement_date: string;
  charge_currency: string | null;
  settlement_currency: string | null;
  charge_debit: string | null;
  charge_credit: string | null;
  settle_debit: string | null;
  settle_credit: string | null;
  charge_base_debit: string | null;
  charge_base_credit: string | null;
  settle_base_debit: string | null;
  settle_base_credit: string | null;
  charge_customer_id: number | null;
  charge_supplier_id: number | null;
  charge_factory_supplier_id: number | null;
  settle_customer_id: number | null;
  settle_supplier_id: number | null;
  settle_factory_supplier_id: number | null;
  recognition_voucher_id: number | null;
  realized_record_id: number | null;
  recognition_deleted: string | null;
  reversed_by: number | null;
}

export interface RealizedFxPreview {
  matchId: number;
  domain: Domain;
  partyId: number;
  nativeCurrency: string;
  nativeMatchedAmount: string;
  chargeVoucher: string;
  settlementVoucher: string;
  chargeHistoricalUsd: string;
  settlementHistoricalUsd: string;
  realizedGainUsd: string;
  status: "ready" | "no_difference" | "recognized" | "reversed" | "blocked";
  postable: boolean;
  issue: string | null;
  recognitionVoucherId: number | null;
  classification: "REALIZED_FX_NOT_UNREALIZED_REVALUATION";
}

export async function loadMatchTx(tx: DbTransaction, companyId: number, matchId: number) {
  await assertTransactionCompanyScope(tx, companyId);
  const matched = resultRows<MatchedRow>(
    await tx.execute(sql`
    SELECT m.id,m.company_id,m.domain,m.party_id,m.amount::text,m.currency,
      m.applied_on::text,m.voided_at::text,m.charge_entry_id,m.settlement_entry_id,
      ch.id AS charge_voucher_id,pv.id AS settlement_voucher_id,
      ch.voucher_number AS charge_voucher,pv.voucher_number AS settlement_voucher,
      ch.source_module AS charge_module,pv.source_module AS settlement_module,
      ch.deleted_at::text AS charge_deleted,pv.deleted_at::text AS settlement_deleted,
      ch.optional AS charge_optional,pv.optional AS settlement_optional,
      COALESCE(ch.effective_date,ch.voucher_date)::text AS charge_date,
      COALESCE(pv.effective_date,pv.voucher_date)::text AS settlement_date,
      ce.transaction_currency AS charge_currency,se.transaction_currency AS settlement_currency,
      ce.transaction_debit_amount::text AS charge_debit,
      ce.transaction_credit_amount::text AS charge_credit,
      se.transaction_debit_amount::text AS settle_debit,
      se.transaction_credit_amount::text AS settle_credit,
      ce.base_debit_amount::text AS charge_base_debit,
      ce.base_credit_amount::text AS charge_base_credit,
      se.base_debit_amount::text AS settle_base_debit,
      se.base_credit_amount::text AS settle_base_credit,
      ce.customer_id AS charge_customer_id,ce.supplier_id AS charge_supplier_id,
      ce.factory_supplier_id AS charge_factory_supplier_id,
      se.customer_id AS settle_customer_id,se.supplier_id AS settle_supplier_id,
      se.factory_supplier_id AS settle_factory_supplier_id,
      rec.voucher_id AS recognition_voucher_id,rec.id AS realized_record_id,
      rv.deleted_at::text AS recognition_deleted,
      reversal.id AS reversed_by
    FROM accounting_open_item_matches m
      JOIN voucher_entries ce ON ce.id=m.charge_entry_id
      JOIN voucher_entries se ON se.id=m.settlement_entry_id
      JOIN vouchers ch ON ch.id=ce.voucher_id AND ch.company_id=m.company_id
      JOIN vouchers pv ON pv.id=se.voucher_id AND pv.company_id=m.company_id
      LEFT JOIN accounting_fx_realizations rec ON rec.match_id=m.id
        AND rec.company_id=m.company_id
      LEFT JOIN vouchers rv ON rv.id=rec.voucher_id AND rv.company_id=m.company_id
      LEFT JOIN vouchers reversal ON reversal.reversal_of_voucher_id=rv.id
        AND reversal.company_id=m.company_id AND reversal.deleted_at IS NULL
    WHERE m.company_id=${companyId} AND m.id=${matchId}
    LIMIT 1
  `)
  )[0];
  if (!matched) throw new MonetaryFxError("FX_MATCH_NOT_FOUND", "No matching record exists in this company", 404);
  return matched;
}
