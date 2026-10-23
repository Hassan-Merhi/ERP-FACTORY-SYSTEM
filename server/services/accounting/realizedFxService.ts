/**
 * Phase 5: exact realized FX from the Phase 3 invoice/payment match.
 *
 * Matching a customer/supplier entry records native settlement but does NOT
 * create an FX voucher. An authorized accountant may explicitly recognize
 * the base-currency residual once. Supplier Partner / Factory supplier FX
 * inside-outside adjustments are intentionally excluded from automatic GL
 * correction because they follow different settlement policy.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { companyBusinessDate } from "./companyBusinessDate";
import { ensureSystemAccounts } from "./systemAccounts";
import { postErpVoucherTx } from "./erpVoucherPosting";
import { writeAuditEvent } from "../audit";
import { MonetaryFxError, fxCurrency, fxDay } from "./monetaryFxRates";

type Domain = "customer" | "supplier" | "factory_supplier";
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
const dec = (v: unknown) => new Decimal(String(v ?? "0"));
const fmt = (n: Decimal) => n.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
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
async function loadMatchTx(tx: DbTransaction, companyId: number, matchId: number) {
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
export async function previewRealizedFxTx(
  tx: DbTransaction,
  companyId: number,
  matchId: number
): Promise<RealizedFxPreview> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || !Number.isSafeInteger(matchId) || matchId <= 0)
    throw new MonetaryFxError("FX_MATCH_INVALID", "Invalid match or company", 400);
  const row = await loadMatchTx(tx, companyId, matchId);
  const native = dec(row.amount),
    domain = row.domain;
  const code = fxCurrency(row.currency);
  const base = {
    matchId: Number(row.id),
    domain,
    partyId: Number(row.party_id),
    nativeCurrency: code,
    nativeMatchedAmount: fmt(native),
    chargeVoucher: row.charge_voucher,
    settlementVoucher: row.settlement_voucher,
    chargeHistoricalUsd: "0.000000",
    settlementHistoricalUsd: "0.000000",
    realizedGainUsd: "0.000000",
    classification: "REALIZED_FX_NOT_UNREALIZED_REVALUATION" as const,
    recognitionVoucherId: row.recognition_voucher_id ? Number(row.recognition_voucher_id) : null,
  };
  const blocked = (issue: string): RealizedFxPreview => ({ ...base, status: "blocked", postable: false, issue });
  if (row.voided_at || row.charge_deleted || row.settlement_deleted || row.charge_optional || row.settlement_optional)
    return blocked("A source voucher or match is deleted, unposted, or cancelled");
  if (code === "USD") return { ...base, status: "no_difference", postable: false, issue: null };
  // An edited voucher may no longer belong to the same party as the stored
  // open-item match. Only accept the original direct supplier/customer
  // ownership (linked customer-ledger ownership needs manual review).
  const chargeParty =
    domain === "customer"
      ? row.charge_customer_id
      : domain === "supplier"
        ? row.charge_supplier_id
        : row.charge_factory_supplier_id;
  const settleParty =
    domain === "customer"
      ? row.settle_customer_id
      : domain === "supplier"
        ? row.settle_supplier_id
        : row.settle_factory_supplier_id;
  if (
    Number(chargeParty) !== Number(row.party_id) ||
    Number(settleParty) !== Number(row.party_id) ||
    chargeParty === null ||
    settleParty === null
  )
    return blocked("Original customer/supplier ownership changed or requires linked-ledger review");
  if (
    row.charge_currency === null ||
    row.settlement_currency === null ||
    fxCurrency(row.charge_currency) !== code ||
    fxCurrency(row.settlement_currency) !== code ||
    [
      row.charge_debit,
      row.charge_credit,
      row.settle_debit,
      row.settle_credit,
      row.charge_base_debit,
      row.charge_base_credit,
      row.settle_base_debit,
      row.settle_base_credit,
    ].some((v) => v === null)
  )
    return blocked("Original currency and historical USD columns must be verified on both lines");
  const chargeNative = domain === "customer" ? dec(row.charge_debit) : dec(row.charge_credit);
  const settledNative = domain === "customer" ? dec(row.settle_credit) : dec(row.settle_debit);
  const chargeBase = domain === "customer" ? dec(row.charge_base_debit) : dec(row.charge_base_credit);
  const settledBase = domain === "customer" ? dec(row.settle_base_credit) : dec(row.settle_base_debit);
  if (
    native.lte(0) ||
    chargeNative.lte(0) ||
    settledNative.lte(0) ||
    native.gt(chargeNative) ||
    native.gt(settledNative) ||
    chargeBase.lte(0) ||
    settledBase.lte(0)
  )
    return blocked("Invoice/payment amounts are incompatible with the saved allocation");
  const chargeUsd = chargeBase.times(native).div(chargeNative);
  const settledUsd = settledBase.times(native).div(settledNative);
  // Party's receivable/payable residual is the opposite of the FX gain:
  // Customer:  Dr AR on receipt at higher USD value -> Cr FX gain.
  // Supplier:  Dr AP on settlement at lower USD value -> Cr FX gain.
  const gain = domain === "customer" ? settledUsd.minus(chargeUsd) : chargeUsd.minus(settledUsd);
  const gainRounded = gain.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const recorded = !!row.realized_record_id;
  const reversed = recorded && (!!row.reversed_by || !!row.recognition_deleted);
  const status = recorded ? (reversed ? "reversed" : "recognized") : gainRounded.isZero() ? "no_difference" : "ready";
  return {
    ...base,
    chargeHistoricalUsd: fmt(chargeUsd),
    settlementHistoricalUsd: fmt(settledUsd),
    realizedGainUsd: fmt(gainRounded),
    status,
    postable: status === "ready" && domain !== "factory_supplier",
    issue:
      domain === "factory_supplier"
        ? "Factory supplier currency exposures use the inside/outside settlement policy; manual review required"
        : reversed
          ? "Recognition voucher has been reversed; no automatic re-post"
          : null,
  };
}
export async function listRealizedFxTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    domain?: Domain;
    partyId?: number;
    asOfDate: string;
  }
) {
  await assertTransactionCompanyScope(tx, input.companyId);
  const date = fxDay(input.asOfDate);
  const domain = input.domain ? sql`AND domain=${input.domain}` : sql``;
  const party = input.partyId ? sql`AND party_id=${input.partyId}` : sql``;
  const matches = resultRows<{ id: number } & Record<string, unknown>>(
    await tx.execute(sql`
    SELECT id FROM accounting_open_item_matches WHERE company_id=${input.companyId}
      AND applied_on<=${date}::date ${domain} ${party}
    ORDER BY applied_on DESC,id DESC LIMIT 300
  `)
  );
  const items: RealizedFxPreview[] = [];
  for (const record of matches) items.push(await previewRealizedFxTx(tx, input.companyId, Number(record.id)));
  return {
    companyId: input.companyId,
    asOfDate: date,
    accountingMode: "RECORDED_NATIVE_AND_HISTORIC_BASE_ONLY",
    items,
    limitedToMostRecent: 300,
    recognitionStatusAsOf: false,
    asOfLimitations:
      "Matches are selected by applied date. Recognition/reversal status is current; historical recognition event reconstruction belongs to Phase 10.",
  };
}
export async function recognizeRealizedFxTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    matchId: number;
    actor: { userId: string; username: string };
    reason: string;
  }
) {
  if (!input.reason?.trim())
    throw new MonetaryFxError("FX_REASON_REQUIRED", "State why this realized FX adjustment is being recognized", 400);
  await assertTransactionCompanyScope(tx, input.companyId);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`realized-fx:${input.companyId}:${input.matchId}`}))`);
  const preview = await previewRealizedFxTx(tx, input.companyId, input.matchId);
  if (preview.status === "recognized") return { voucherId: preview.recognitionVoucherId, replayed: true, preview };
  if (!preview.postable)
    throw new MonetaryFxError(
      "FX_NOT_POSTABLE",
      preview.issue ?? "No unrecognized realized FX adjustment is available"
    );
  // Source allocation may be voided concurrently. Lock it in the same tx
  // before evaluating the accounting adjustment and writing the voucher.
  await tx.execute(sql`SELECT id FROM accounting_open_item_matches
      WHERE company_id=${input.companyId} AND id=${input.matchId} FOR UPDATE`);
  const fresh = await previewRealizedFxTx(tx, input.companyId, input.matchId);
  if (!fresh.postable)
    throw new MonetaryFxError("FX_NOT_POSTABLE", "This match has changed and can no longer be recognized");
  const bookDate = await companyBusinessDate(input.companyId, tx);
  await tx.execute(sql`SELECT erp_assert_accounting_date_open(${input.companyId},${bookDate}::date)`);
  const status = (await ensureSystemAccounts(tx, input.companyId, ["FX-REALIZED"]))[0];
  if (!status || !["ok", "created"].includes(status.state))
    throw new MonetaryFxError(
      "FX_GAIN_LOSS_ACCOUNT_UNAVAILABLE",
      "A valid Realized FX Gain/Loss system account is required"
    );
  if (!("accountId" in status))
    throw new MonetaryFxError("FX_GAIN_LOSS_ACCOUNT_UNAVAILABLE", "Cannot determine the FX gain/loss account");
  const amount = dec(fresh.realizedGainUsd);
  const basis = amount.abs().toDecimalPlaces(2).toFixed(2);
  if (dec(basis).isZero()) throw new MonetaryFxError("FX_ZERO_ADJUSTMENT", "Realized FX rounds to zero");
  const partyLine = fresh.domain === "customer" ? { customerId: fresh.partyId } : { supplierId: fresh.partyId };
  const narrative = `Realized FX for matched ${fresh.nativeCurrency} invoice ${fresh.chargeVoucher}, settlement ${fresh.settlementVoucher}; match #${input.matchId}`;
  const matchSource = await loadMatchTx(tx, input.companyId, input.matchId);
  const origin = String(matchSource.charge_module ?? "").toUpperCase();
  const sourceModule = ["ERP", "FACTORY", "PROPERTIES"].includes(origin) ? origin : "ERP";
  const gain = amount.gt(0);
  const posted = await postErpVoucherTx(tx, {
    companyId: input.companyId,
    voucherType: "Journal",
    voucherDate: bookDate,
    description: narrative,
    sourceModule,
    currency: "USD",
    source: { type: "fx-realized-open-item", id: String(input.matchId) },
    actor: { userId: input.actor.userId, username: input.actor.username, reason: input.reason.trim() },
    lines: [
      { ...partyLine, ...(gain ? { debit: basis } : { credit: basis }), narration: narrative },
      { ledgerAccountId: status.accountId, ...(gain ? { credit: basis } : { debit: basis }), narration: narrative },
    ],
  });
  await tx.execute(sql`
    INSERT INTO accounting_fx_realizations
      (company_id,match_id,voucher_id,native_currency,native_amount,
        historical_charge_base,historical_settlement_base,
        realized_gain_base,recognized_date,actor)
    VALUES(${input.companyId},${input.matchId},${Number(posted.voucher.id)},
      ${fresh.nativeCurrency},${fresh.nativeMatchedAmount}::numeric,
      ${fresh.chargeHistoricalUsd}::numeric,${fresh.settlementHistoricalUsd}::numeric,
      ${fresh.realizedGainUsd}::numeric,${bookDate}::date,${input.actor.userId})
    ON CONFLICT(company_id,match_id) DO NOTHING
  `);
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "create",
      tableName: "accounting_fx_realizations",
      recordId: Number(posted.voucher.id),
      recordIdentifier: `match:${input.matchId}`,
      changes: {
        gainBase: { new: fresh.realizedGainUsd },
        voucherId: { new: posted.voucher.id },
        invoice: { new: fresh.chargeVoucher },
        settlement: { new: fresh.settlementVoucher },
        originalCurrency: { new: fresh.nativeCurrency },
        reason: { new: input.reason.trim() },
      },
    },
    tx
  );
  return { voucherId: Number(posted.voucher.id), replayed: posted.replayed, preview: fresh };
}
