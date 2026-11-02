/**
 * PRIVATE BACKEND ONLY. Historical factory supplier expense audit.
 *
 * Run manually from an authorized backend shell:
 *   npx tsx scripts/audit-historical-factory-suppliers-20261102.ts
 *
 * No route, UI, startup job, posting, adjustment, or mutation of any kind.
 * This script begins a REPEATABLE READ READ ONLY PostgreSQL transaction,
 * applies company 12 RLS for that transaction, and emits JSON to stdout.
 * Every proposed accounting adjustment is null pending evidence/review.
 */
import Decimal from "decimal.js";
import { pool } from "../server/db";
import { factoryBusinessDateInBeirut } from "./historical-supplier-date-safety";
import { classifyHistoricalSupplierVoucher } from "./historical-supplier-audit-classifier";
import { previewHistoricalCostAllocation } from "./historical-supplier-cost-allocation-preview";
import { inspectFactoryAccountType, type FactoryAccountAuditRow } from "./historical-supplier-ledger-classification";
import { classifyFreightOffsetEvidence } from "./historical-supplier-freight-offset-review";
import { previewHistoricalChargesPeriodNeutrality, type HistoricalClearingPeriodRow } from "./historical-charges-period-neutral-preflight";
import { inspectHistoricalPostOffloadLink, type HistoricalPostOffloadLink } from "./historical-post-offload-voucher-source-audit";
import { assessPostOffloadDuplicateSource, type PostOffloadDuplicateSourceReview } from "./historical-freight-batch-replay-guard";
import { previewCharge64CreditorImpact } from "./historical-charge64-creditor-impact-preview";

const COMPANY = 12;
const EXPECTED_GOODS = 38;
const EXPECTED_COMMISSIONS = 48;
const REPAIR_DAY = "2026-10-14";

const money = (value: unknown) => new Decimal(value == null ? "0" : String(value));
const fixed = (amount: Decimal) => amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const num = (value: unknown) => Number(value ?? 0);
type SqlRow = Record<string, unknown>;

interface LedgerLine extends SqlRow {
  voucher_id: number;
  voucher_number: string;
  voucher_date: string;
  recorded_at: string;
  description: string;
  ledger_code: string | null;
  account_type: string | null;
  factory_supplier_id: number | null;
  supplier_name: string | null;
  debit_usd: string;
  credit_usd: string;
  currency: string | null;
  exchange_rate: string | null;
}
interface Container extends SqlRow {
  id: number;
  container_number: string;
  status: string | null;
  arrival_date: string | null;
  created_on: string;
  supplier_id: number | null;
  supplier_name: string | null;
  commission_supplier_id: number | null;
  commission_supplier_name: string | null;
  commission_currency_code: string | null;
  total_kg: string;
  rate_per_kg: string;
  currency_code: string | null;
  fx_rate_to_usd: string | null;
  commission_amount: string | null;
}

function sourceId(voucherNumber: string, kind: "goods" | "commission"): number {
  const pattern = kind === "goods" ? /^FACTORY-IMPORT-(\d+)-\d+$/ : /^FACTORY-COMM-(\d+)(?:-|$)/;
  const match = pattern.exec(voucherNumber);
  if (!match) throw new Error("Unknown source identity for audited voucher " + voucherNumber);
  return Number(match[1]);
}

export async function auditHistoricalFactorySuppliers() {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // Explicit company scope in the SAME transaction/connection as every SELECT.
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(COMPANY)]);

    const rows = (await client.query<LedgerLine>(
      [
        "SELECT v.id AS voucher_id, v.voucher_number, v.voucher_date::text AS voucher_date,",
        "v.created_at::text AS recorded_at, v.description, v.currency,",
        "v.exchange_rate::text AS exchange_rate, la.code AS ledger_code,",
        "la.account_type, ve.factory_supplier_id, fs.name AS supplier_name,",
        "ve.debit_amount::text AS debit_usd, ve.credit_amount::text AS credit_usd",
        "FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id",
        "LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = v.company_id",
        "LEFT JOIN factory_suppliers fs ON fs.id = ve.factory_supplier_id AND fs.company_id = v.company_id",
        "WHERE v.company_id = $1 AND v.deleted_at IS NULL AND COALESCE(v.optional,false) = false",
        "AND (v.description LIKE 'Goods import - container % (historical supplier reconciliation)'",
        "OR (v.voucher_number ~ '^FACTORY-COMM-[0-9]+(-|$)'",
        "AND v.created_at >= $2::date AND v.created_at < ($2::date + INTERVAL '1 day')))",
        "ORDER BY v.id, ve.id",
      ].join("\n"), [COMPANY, REPAIR_DAY]
    )).rows;

    const byVoucher = new Map<number, LedgerLine[]>();
    for (const line of rows) {
      const voucherId = num(line.voucher_id);
      const bucket = byVoucher.get(voucherId) ?? [];
      bucket.push(line);
      byVoucher.set(voucherId, bucket);
    }
    const refs = [...byVoucher.values()].map((lines) => {
      const line = lines[0];
      const kind = line.description.includes("(historical supplier reconciliation)") ? "goods" as const : "commission" as const;
      return { id: num(line.voucher_id), kind, containerId: sourceId(line.voucher_number, kind), lines };
    });
    if (refs.filter((row) => row.kind === "goods").length !== EXPECTED_GOODS ||
        refs.filter((row) => row.kind === "commission").length !== EXPECTED_COMMISSIONS) {
      throw new Error("Historical backfill set changed: refused partial/incorrect audit (" +
        refs.filter((row) => row.kind === "goods").length + " goods; " +
        refs.filter((row) => row.kind === "commission").length + " commission)");
    }

    const containerIds = [...new Set(refs.map((row) => row.containerId))];
    const voucherIds = refs.map((row) => row.id);
    const containers = (await client.query<Container>(
      [
        "SELECT c.id,c.container_number,c.status,c.arrival_date::text AS arrival_date,",
        "c.created_at::date::text AS created_on,c.supplier_id,fs.name AS supplier_name,",
        "c.commission_supplier_id,cs.name AS commission_supplier_name,c.commission_currency_code,",
        "c.total_kg::text AS total_kg,c.rate_per_kg::text AS rate_per_kg,",
        "c.currency_code,c.fx_rate_to_usd::text AS fx_rate_to_usd,",
        "c.commission_amount::text AS commission_amount",
        "FROM factory_containers c LEFT JOIN factory_suppliers fs",
        "ON fs.company_id=c.company_id AND fs.id=c.supplier_id",
        "LEFT JOIN factory_suppliers cs ON cs.company_id=c.company_id AND cs.id=c.commission_supplier_id",
        "WHERE c.company_id=$1 AND c.id=ANY($2::int[]) AND c.deleted_at IS NULL",
      ].join("\n"), [COMPANY, containerIds]
    )).rows;
    const containerMap = new Map(containers.map((c) => [num(c.id), c]));

    const stock = (await client.query<SqlRow>(
      [
        "SELECT container_id,COALESCE(SUM(received_kg),0)::text AS received_kg,",
        "COALESCE(SUM(used_kg),0)::text AS used_kg,",
        // Match factoryStockValuation: each positive (received_kg - used_kg)
        // counts as stock. The legacy quantity_kg is NOT remaining stock.
        "COALESCE(SUM(GREATEST(received_kg-used_kg,0)),0)::text AS remaining_kg,",
        "COALESCE(SUM(GREATEST(used_kg-received_kg,0)),0)::text AS overused_kg,",
        "COALESCE(SUM(CASE WHEN received_kg>used_kg THEN (received_kg-used_kg)*cost_per_kg_usd ELSE 0 END),0)::text AS remaining_value_usd,",
        "COUNT(*) FILTER(WHERE received_kg>used_kg AND cost_per_kg_usd IS NULL)::int AS unvalued_raw_rows,",
        "COALESCE(SUM(quantity_kg),0)::text AS legacy_quantity_kg,",
        "MIN(offloaded_at)::text AS first_offloaded_at",
        "FROM factory_raw_stock WHERE company_id=$1 AND container_id=ANY($2::int[])",
        "AND deleted_at IS NULL GROUP BY container_id",
      ].join("\n"), [COMPANY, containerIds]
    )).rows;
    const stockMap = new Map(stock.map((r) => [num(r.container_id), r]));

    const receipts = (await client.query<SqlRow>(
      [
        "SELECT container_id,COUNT(*)::int AS receipt_count,",
        "MIN(receipt_date)::text AS first_receipt_date,",
        "MAX(receipt_date)::text AS last_receipt_date,",
        "COALESCE(SUM(receipt_value_usd),0)::text AS received_value_usd",
        "FROM factory_container_receipts WHERE company_id=$1",
        "AND container_id=ANY($2::int[]) AND deleted_at IS NULL GROUP BY container_id",
      ].join("\n"), [COMPANY, containerIds]
    )).rows;
    const receiptMap = new Map(receipts.map((r) => [num(r.container_id), r]));

    // PROVENANCE ONLY. Source costs can include supplier-average and landed charges,
    // and cannot simply be equated to the historic import voucher face amount.
    const mixSources = (await client.query<SqlRow>(
      [
        "SELECT s.container_id,COUNT(DISTINCT s.mix_batch_id)::int AS source_mix_count,",
        "COALESCE(SUM(COALESCE(s.weight_kg,s.quantity_kg,0)),0)::text AS source_mix_weight_kg,",
        "COALESCE(SUM(s.total_cost),0)::text AS source_mix_cost_usd",
        "FROM factory_mix_batch_sources s JOIN factory_mix_batches m",
        "ON m.id=s.mix_batch_id AND m.company_id=$1 AND m.deleted_at IS NULL",
        "WHERE s.container_id=ANY($2::int[]) GROUP BY s.container_id",
      ].join("\n"), [COMPANY, containerIds]
    )).rows;
    const mixSourceMap = new Map(mixSources.map((r) => [num(r.container_id), r]));

    // A distinct mix may combine materials from multiple containers. Count
    // and value it ONCE, but never allocate its total to one supplier.
    const relatedMixSnapshot = (await client.query<SqlRow>(
      [
        "WITH linked AS (",
        " SELECT DISTINCT s.mix_batch_id FROM factory_mix_batch_sources s",
        " JOIN factory_mix_batches m ON m.id=s.mix_batch_id AND m.company_id=$1",
        " WHERE s.container_id=ANY($2::int[]) AND m.deleted_at IS NULL",
        ") SELECT COUNT(*)::int AS linked_mix_count,",
        "COALESCE(SUM(GREATEST(m.total_weight_kg-m.used_kg,0)),0)::text AS unconsumed_mix_weight_kg,",
        "COALESCE(SUM(GREATEST(m.total_weight_kg-m.used_kg,0)*m.cost_per_kg),0)::text AS mix_wip_value_usd,",
        "COUNT(*) FILTER (WHERE m.cost_per_kg<=0)::int AS zero_cost_mix_count",
        "FROM linked JOIN factory_mix_batches m ON m.id=linked.mix_batch_id AND m.company_id=$1",
        "AND m.deleted_at IS NULL AND m.status <> 'CLOSED'",
      ].join("\n"), [COMPANY, containerIds.filter((id) => refs.some((ref) => ref.kind === "goods" && ref.containerId === id))]
    )).rows[0];

    const baleLineage = (await client.query<SqlRow>(
      [
        "SELECT COUNT(*)::int AS factory_bale_count,",
        "COUNT(*) FILTER (WHERE mix_batch_id IS NOT NULL)::int AS direct_mix_links,",
        "COUNT(*) FILTER (WHERE pressing_batch_id IS NOT NULL)::int AS pressing_links",
        "FROM factory_bales WHERE company_id=$1 AND deleted_at IS NULL",
      ].join("\n"), [COMPANY]
    )).rows[0];
    const pressingLinkCoverage = (await client.query<SqlRow>(
      "SELECT COUNT(*)::int AS n FROM factory_pressing_batches WHERE company_id=$1 AND mix_batch_id IS NOT NULL",
      [COMPANY]
    )).rows[0];

    const otherExpense = (await client.query<SqlRow>(
      [
        "SELECT v.id AS voucher_id,v.voucher_number,v.voucher_date::text AS voucher_date,",
        "la.code AS account_code,ve.debit_amount::text AS debit_usd,",
        "ve.credit_amount::text AS credit_usd",
        "FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id=v.id",
        "JOIN ledger_accounts la ON la.id=ve.ledger_account_id AND la.company_id=v.company_id",
        "WHERE v.company_id=$1 AND v.deleted_at IS NULL",
        "AND COALESCE(v.optional,false)=false AND v.id <> ALL($2::int[])",
        "AND v.voucher_number ~ '^FACTORY-(IMPORT|COMM|FREIGHT|OC|POC)-[0-9]+(-|$)'",
        "AND la.account_type ILIKE '%expense%'",
        "ORDER BY v.id",
      ].join("\n"), [COMPANY, voucherIds]
    )).rows;
    const relatedExpense = new Map<number, SqlRow[]>();
    for (const other of otherExpense) {
      const m = /^FACTORY-(?:IMPORT|COMM|FREIGHT|OC|POC)-(\d+)(?:-|$)/.exec(String(other.voucher_number));
      if (!m || !containerMap.has(Number(m[1]))) continue;
      const id = Number(m[1]);
      const bucket = relatedExpense.get(id) ?? [];
      bucket.push(other);
      relatedExpense.set(id, bucket);
    }

    const cutovers = (await client.query<SqlRow>(
      "SELECT status,effective_from::text AS effective_from,applied_at::text AS applied_at FROM gl_inventory_cutovers WHERE company_id=$1",
      [COMPANY]
    )).rows;
    const stockJournals = (await client.query<SqlRow>(
      "SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id=$1 AND deleted_at IS NULL AND voucher_number LIKE 'GL-FACTORY-STOCK-%'",
      [COMPANY]
    )).rows;

    // The existing account_type is the input used by ledger reporting; compare
    // it with documented factory system-account semantics, never UPDATE it.
    const accountRows = (await client.query<FactoryAccountAuditRow & SqlRow>(
      [
        "SELECT a.code,a.name,a.account_type AS \"accountType\",",
        "COALESCE(x.debit,0)::text AS \"debitUsd\",",
        "COALESCE(x.credit,0)::text AS \"creditUsd\",",
        "COALESCE(x.vouchers,0)::int AS \"voucherCount\",",
        "COALESCE(x.lines,0)::int AS \"postedLineCount\"",
        "FROM ledger_accounts a LEFT JOIN LATERAL (",
        "SELECT COUNT(DISTINCT v.id)::int vouchers,COUNT(*)::int lines,",
        "COALESCE(SUM(ve.debit_amount),0) debit,",
        "COALESCE(SUM(ve.credit_amount),0) credit",
        "FROM voucher_entries ve JOIN vouchers v ON v.id=ve.voucher_id",
        "WHERE ve.ledger_account_id=a.id AND v.company_id=$1",
        "AND v.deleted_at IS NULL AND COALESCE(v.optional,false)=false",
        ") x ON TRUE",
        "WHERE a.company_id=$1 AND a.deleted_at IS NULL",
        "AND a.code IN ('FACTORY_CHARGES_PAYABLE','FACTORY_RAW_MATERIAL_STOCK')",
        "ORDER BY a.code",
      ].join("\n"), [COMPANY]
    )).rows;
    const accountClassificationAudit = accountRows.map(inspectFactoryAccountType);
    const payableAccount = accountRows.find((row) => row.code === "FACTORY_CHARGES_PAYABLE");
    if (!payableAccount) throw new Error("Missing clearing ledger account: audit refuses guessed financial impact");

    // A type-only repair would change recognized historical P&L by the
    // clearing-account's entire debit balance. This groups ACTIVE, posted
    // vouchers by effective accounting period and source. Never books journals.
    const clearingPeriods = (await client.query<HistoricalClearingPeriodRow & SqlRow>(
      [
        "WITH sources AS (",
        "SELECT v.id,TO_CHAR(COALESCE(v.effective_date,v.voucher_date),'YYYY-MM') AS period,",
        "SUBSTRING(v.voucher_number FROM '^FACTORY-(FREIGHT|OC|POC)-') AS source,",
        "p.debit_amount AS payable_dr,p.credit_amount AS payable_cr",
        "FROM vouchers v JOIN voucher_entries p ON p.voucher_id=v.id",
        "JOIN ledger_accounts a ON a.id=p.ledger_account_id",
        "WHERE v.company_id=$1 AND a.company_id=$1 AND a.code='FACTORY_CHARGES_PAYABLE'",
        "AND v.deleted_at IS NULL AND COALESCE(v.optional,false)=false",
        "AND v.voucher_number ~ '^FACTORY-(FREIGHT|OC|POC)-'",
        "), per_voucher AS (",
        "SELECT s.id,s.period,s.source,s.payable_dr,s.payable_cr,",
        "COUNT(*)::int AS n_lines,SUM(ve.debit_amount) AS debit,SUM(ve.credit_amount) AS credit,",
        "COUNT(*) FILTER(WHERE ve.supplier_id IS NOT NULL OR ve.factory_supplier_id IS NOT NULL",
        "OR ve.customer_id IS NOT NULL OR ve.bank_account_id IS NOT NULL)::int AS party_lines",
        "FROM sources s JOIN voucher_entries ve ON ve.voucher_id=s.id",
        "GROUP BY s.id,s.period,s.source,s.payable_dr,s.payable_cr",
        ") SELECT period,source,COUNT(*)::int AS \"voucherCount\",",
        "SUM(payable_dr)::text AS \"clearingDebitUsd\",",
        "SUM(payable_cr)::text AS \"clearingCreditUsd\",",
        "COUNT(*) FILTER (WHERE n_lines=2 AND ABS(debit-credit)<=0.01)::int AS \"balancedTwoLineVoucherCount\",",
        "SUM(party_lines)::int AS \"directSupplierCustomerBankLineCount\"",
        "FROM per_voucher GROUP BY period,source ORDER BY period,source",
      ].join("\n"), [COMPANY]
    )).rows;
    const clearingPeriodNeutralityPreview = previewHistoricalChargesPeriodNeutrality(clearingPeriods, {
      currentAccountType: payableAccount.accountType,
      actualPostedDebitUsd: payableAccount.debitUsd,
      actualPostedCreditUsd: payableAccount.creditUsd,
      expectedVoucherCount: payableAccount.voucherCount,
    });

    // Trace native POC voucher amounts back to a persistent source charge ID.
    // Some old charge rows have voucher_id updated to a different voucher;
    // that mismatch is evidence for review, never proof of double-booking.
    const pocRows = (await client.query<HistoricalPostOffloadLink & SqlRow>(
      [
        "SELECT v.id AS \"voucherId\",v.voucher_number AS \"voucherNumber\",",
        "SUBSTRING(v.voucher_number FROM '^FACTORY-POC-(?:BACKFILL-)?([0-9]+)-')::int AS \"voucherContainerId\",",
        "SUBSTRING(v.voucher_number FROM '^FACTORY-POC-(?:BACKFILL-)?[0-9]+-([0-9]+)')::int AS \"parsedSourceChargeId\",",
        "v.total_amount::text AS \"voucherNativeAmount\",v.currency AS \"voucherCurrency\",",
        "c.id AS \"sourceChargeId\",c.voucher_id AS \"sourceVoucherId\",",
        "c.container_id AS \"sourceContainerId\",c.amount::text AS \"sourceNativeAmount\",",
        "c.currency_code AS \"sourceCurrency\",c.deleted_at::text AS \"sourceDeletedAt\",",
        "c.supplier_inventory_value_delta_usd::text AS \"sourceInventoryValueDeltaUsd\"",
        "FROM vouchers v LEFT JOIN factory_offload_additional_charges c",
        "ON c.company_id=v.company_id AND c.id=SUBSTRING(v.voucher_number FROM",
        "'^FACTORY-POC-(?:BACKFILL-)?[0-9]+-([0-9]+)')::int",
        "WHERE v.company_id=$1 AND v.deleted_at IS NULL AND COALESCE(v.optional,false)=false",
        "AND v.voucher_number LIKE 'FACTORY-POC-%' ORDER BY v.id",
      ].join("\n"), [COMPANY]
    )).rows;
    const postOffloadSourceLinks = pocRows.map(inspectHistoricalPostOffloadLink);

    // A single source charge can have two fully active vouchers. Its current
    // charge.voucher_id points to just one, so source-link-only audits miss the
    // second. Group by both IDs parsed from the voucher NUMBER, not description.
    const duplicateSources = (await client.query<SqlRow>(
      [
        "WITH parsed AS (",
        "SELECT v.id,v.voucher_number,v.voucher_date::text AS voucher_date,v.total_amount,",
        "SUBSTRING(v.voucher_number FROM '^FACTORY-POC-(?:BACKFILL-)?([0-9]+)-')::int AS container_id,",
        "SUBSTRING(v.voucher_number FROM '^FACTORY-POC-(?:BACKFILL-)?[0-9]+-([0-9]+)')::int AS charge_id",
        "FROM vouchers v WHERE v.company_id=$1 AND v.deleted_at IS NULL",
        "AND COALESCE(v.optional,false)=false AND v.voucher_number LIKE 'FACTORY-POC-%'",
        ") SELECT container_id,charge_id,COUNT(*)::int AS active_count,",
        "JSONB_AGG(JSONB_BUILD_OBJECT(",
        "'voucherId',id,'voucherNumber',voucher_number,",
        "'voucherDate',voucher_date,'amountNative',total_amount::text",
        ") ORDER BY id) AS active_vouchers",
        "FROM parsed GROUP BY container_id,charge_id HAVING COUNT(*)>1",
        "ORDER BY container_id,charge_id",
      ].join("\n"), [COMPANY]
    )).rows;

    // The original company-12 source-specific correction for charge #64 was
    // posted and later SOFT DELETED. Including retired corrections is essential;
    // an active-voucher-only audit would mistake the historical review as absent.
    const originalCorrection = (await client.query<SqlRow>(
      "SELECT id,voucher_number,deleted_at::text AS deleted_at,total_amount::text AS amount_native " +
      "FROM vouchers WHERE company_id=$1 AND voucher_number='FACTORY-CORRECTION-20261014-83'",
      [COMPANY]
    )).rows[0];
    const duplicatePostOffloadSources = duplicateSources.map((row) => {
      const activeVouchers = row.active_vouchers as PostOffloadDuplicateSourceReview["activeVouchers"];
      if (!Array.isArray(activeVouchers)) throw new Error("Invalid POC voucher evidence JSON");
      const priorCorrection = num(row.container_id) === 83 && num(row.charge_id) === 64 &&
        originalCorrection != null ? {
          voucherId: num(originalCorrection.id),
          voucherNumber: String(originalCorrection.voucher_number),
          deletedAt: originalCorrection.deleted_at == null ? null : String(originalCorrection.deleted_at),
          amountNative: String(originalCorrection.amount_native),
        } : null;
      return assessPostOffloadDuplicateSource({
        companyId: COMPANY,
        containerId: num(row.container_id),
        chargeId: num(row.charge_id),
        activeVoucherCount: num(row.active_count),
        activeVouchers,
        priorCorrection,
      });
    });

    // Container-specific active freight journals, not amount-only duplicate
    // detection. Exact FREIGHT offsets indicate paired GL legs, NOT a second
    // expense or permission to debit inventory.
    const freightRows = (await client.query<SqlRow>(
      [
        "SELECT substring(v.voucher_number FROM '^FACTORY-FREIGHT-([0-9]+)')::int AS container_id,",
        "COUNT(DISTINCT v.id)::int AS freight_voucher_count,",
        "COALESCE(SUM(CASE WHEN la.code='FREIGHT' THEN ve.debit_amount ELSE 0 END),0)::text AS freight_dr,",
        "COALESCE(SUM(CASE WHEN la.code='FREIGHT' THEN ve.credit_amount ELSE 0 END),0)::text AS freight_cr,",
        "COALESCE(SUM(CASE WHEN la.code='FACTORY_CHARGES_PAYABLE' THEN ve.debit_amount ELSE 0 END),0)::text AS clearing_dr,",
        "STRING_AGG(DISTINCT COALESCE(la.code,'(nonledger)'),', ' ORDER BY COALESCE(la.code,'(nonledger)')) AS source_account_codes",
        "FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id=v.id",
        "LEFT JOIN ledger_accounts la ON la.id=ve.ledger_account_id",
        "WHERE v.company_id=$1 AND v.deleted_at IS NULL AND COALESCE(v.optional,false)=false",
        "AND v.voucher_number ~ '^FACTORY-FREIGHT-[0-9]+(-|$)'",
        "AND substring(v.voucher_number FROM '^FACTORY-FREIGHT-([0-9]+)')::int=ANY($2::int[])",
        "GROUP BY 1 ORDER BY 1",
      ].join("\n"), [COMPANY, containerIds]
    )).rows;
    const freightByContainer = new Map(freightRows.map((row) => [num(row.container_id), row]));

    // A second FACTORY-IMPORT voucher would merit inspection, but its
    // absence does not prove other sources have not already expensed the goods.
    const additionalImportRows = (await client.query<SqlRow>(
      [
        "SELECT substring(v.voucher_number FROM '^FACTORY-IMPORT-([0-9]+)')::int AS container_id,",
        "COUNT(DISTINCT v.id)::int AS extra_vouchers,",
        "COALESCE(SUM(CASE WHEN la.code='FACTORY_IMPORT_COST' THEN ve.debit_amount ELSE 0 END),0)::text AS extra_expense_usd",
        "FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id=v.id",
        "LEFT JOIN ledger_accounts la ON la.id=ve.ledger_account_id",
        "WHERE v.company_id=$1 AND v.deleted_at IS NULL AND COALESCE(v.optional,false)=false",
        "AND v.id <> ALL($2::int[]) AND v.voucher_number ~ '^FACTORY-IMPORT-[0-9]+(-|$)'",
        "AND substring(v.voucher_number FROM '^FACTORY-IMPORT-([0-9]+)')::int=ANY($3::int[])",
        "GROUP BY 1",
      ].join("\n"), [COMPANY, voucherIds, containerIds]
    )).rows;
    const additionalImportByContainer = new Map(additionalImportRows.map((row) => [num(row.container_id), row]));


    // Pair the factory-charge account's entries with their original ledger
    // counterparties, to prevent treating a debit balance as a proved expense
    // error. An unrecognized/nonledger counterparty remains explicit.
    const payableCounterparts = (await client.query<SqlRow>(
      [
        "SELECT COALESCE(other_account.code,'(nonledger/party)') AS account_code,",
        "COALESCE(other_account.account_type,'(nonledger/party)') AS account_type,",
        "COUNT(DISTINCT v.id)::int AS vouchers,",
        "COALESCE(SUM(other_line.debit_amount),0)::text AS debit_usd,",
        "COALESCE(SUM(other_line.credit_amount),0)::text AS credit_usd",
        "FROM ledger_accounts payable",
        "JOIN voucher_entries payable_line ON payable_line.ledger_account_id=payable.id",
        "JOIN vouchers v ON v.id=payable_line.voucher_id",
        "AND v.company_id=$1 AND v.deleted_at IS NULL",
        "AND COALESCE(v.optional,false)=false",
        "JOIN voucher_entries other_line ON other_line.voucher_id=v.id",
        "AND other_line.id<>payable_line.id",
        "LEFT JOIN ledger_accounts other_account ON other_account.id=other_line.ledger_account_id",
        "WHERE payable.company_id=$1 AND payable.deleted_at IS NULL",
        "AND payable.code='FACTORY_CHARGES_PAYABLE'",
        "GROUP BY 1,2 ORDER BY 1",
      ].join("\n"), [COMPANY]
    )).rows;

    // Alternate production evidence supports bale existence/processing but
    // does not supply a mix-to-bale relation or attributable historical COGS.
    const supplementalLineage = (await client.query<SqlRow>(
      [
        "SELECT",
        "(SELECT COUNT(DISTINCT bale_id)::int FROM factory_pressing_confirmations",
        " WHERE company_id=$1 AND voided_at IS NULL) AS pressing_confirmation_bales,",
        "(SELECT COUNT(DISTINCT bale_id)::int FROM factory_bale_production_attributions",
        " WHERE company_id=$1) AS production_attribution_bales,",
        "(SELECT COUNT(DISTINCT bale_id)::int FROM factory_legacy_bale_cost_repairs",
        " WHERE company_id=$1) AS historical_bale_repair_bales,",
        "(SELECT COUNT(DISTINCT mix_batch_id)::int FROM factory_daily_usages",
        " WHERE company_id=$1) AS daily_usage_mix_count,",
        "(SELECT COUNT(DISTINCT bale_id)::int FROM factory_pos_sale_bales",
        " WHERE company_id=$1) AS pos_bale_link_count",
      ].join("\n"), [COMPANY]
    )).rows[0];

    // Single-source case: a real, subsequently deleted Oct-14 correction
    // would have changed a named creditor's liability, not a supplier party.
    // Model that creditor and P&L impact as a counterfactual; no GL writes.
    const creditorAccounts = (await client.query<SqlRow>(
      [
        "SELECT a.code,a.account_type,a.opening_balance::text,a.opening_balance_side,",
        "COALESCE(SUM(e.debit_amount),0)::text AS posted_dr,",
        "COALESCE(SUM(e.credit_amount),0)::text AS posted_cr",
        "FROM ledger_accounts a LEFT JOIN voucher_entries e ON e.ledger_account_id=a.id",
        "LEFT JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=$1",
        "AND v.deleted_at IS NULL AND COALESCE(v.optional,false)=false",
        "WHERE a.company_id=$1 AND a.code='WALMDACLE' AND a.deleted_at IS NULL",
        "AND (e.id IS NULL OR v.id IS NOT NULL)",
        "GROUP BY a.code,a.account_type,a.opening_balance,a.opening_balance_side",
      ].join("\n"), [COMPANY]
    )).rows;
    const creditor = creditorAccounts[0];
    if (!creditor || creditorAccounts.length !== 1) throw new Error("WALMDACLE creditor ledger missing/ambiguous");

    const charge64Vouchers = (await client.query<SqlRow>(
      [
        "SELECT v.id,v.voucher_number,v.total_amount::text AS total_amount,",
        "v.deleted_at::text AS deleted_at,COUNT(e.id)::int AS lines,",
        "COALESCE(SUM(CASE WHEN e.ledger_account_id=a_creditor.id THEN e.credit_amount ELSE 0 END),0)::text AS creditor_credit,",
        "COALESCE(SUM(CASE WHEN e.ledger_account_id=a_creditor.id THEN e.debit_amount ELSE 0 END),0)::text AS creditor_debit,",
        "COALESCE(SUM(CASE WHEN e.ledger_account_id=a_clearing.id THEN e.debit_amount ELSE 0 END),0)::text AS clearing_debit,",
        "COALESCE(SUM(CASE WHEN e.ledger_account_id=a_clearing.id THEN e.credit_amount ELSE 0 END),0)::text AS clearing_credit",
        "FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id",
        "JOIN ledger_accounts a_creditor ON a_creditor.company_id=$1 AND a_creditor.code='WALMDACLE'",
        "JOIN ledger_accounts a_clearing ON a_clearing.company_id=$1 AND a_clearing.code='FACTORY_CHARGES_PAYABLE'",
        "WHERE v.company_id=$1 AND v.id IN(9309,9341,15976)",
        "GROUP BY v.id,v.voucher_number,v.total_amount,v.deleted_at ORDER BY v.id",
      ].join("\n"), [COMPANY]
    )).rows;
    const charge64VoucherMap = new Map(charge64Vouchers.map((row) => [num(row.id),row]));
    const extraCharge = charge64VoucherMap.get(9309);
    const retainedCharge = charge64VoucherMap.get(9341);
    const retiredCorrection = charge64VoucherMap.get(15976);
    if (!extraCharge || !retainedCharge || !retiredCorrection) throw new Error("Charge #64 historical voucher proof missing");
    if (num(extraCharge.lines)!==2 || num(retainedCharge.lines)!==2 ||
        num(retiredCorrection.lines)!==2 ||
        extraCharge.deleted_at != null || retainedCharge.deleted_at != null ||
        retiredCorrection.deleted_at == null ||
        !money(extraCharge.creditor_credit).eq(extraCharge.total_amount) ||
        !money(retainedCharge.creditor_credit).eq(retainedCharge.total_amount) ||
        !money(retiredCorrection.creditor_debit).eq(retiredCorrection.total_amount) ||
        !money(retiredCorrection.clearing_credit).eq(retiredCorrection.total_amount)) {
      throw new Error("Charge #64 posting and retired correction no longer match independently verified GL legs");
    }

    const daybook64 = (await client.query<SqlRow>(
      "SELECT id,reference_id,amount_usd::text,amount_currency::text,meta_json " +
      "FROM factory_daybook_entries WHERE company_id=$1 AND id=14136 AND reference_id=83 AND tx_type='OTHER_CHARGE'",
      [COMPANY]
    )).rows[0];
    if (!daybook64 || !String(daybook64.meta_json).includes('"chargeId":64')) {
      throw new Error("Charge 64 daybook evidence changed; cannot simulate correction");
    }

    const audit64 = (await client.query<SqlRow>(
      [
        "SELECT COUNT(*) FILTER(WHERE record_id=9309 AND action='update'",
        "AND changes->'amount'->>'new'='1692.96')::int AS amount_edits,",
        "COUNT(*) FILTER(WHERE record_id=15976 AND action='delete')::int AS delete_events,",
        "MAX(reason) FILTER(WHERE record_id=15976 AND action='delete') AS delete_reason",
        "FROM audit_log WHERE company_id=$1 AND table_name='vouchers' AND record_id IN(9309,15976)",
      ].join("\n"), [COMPANY]
    )).rows[0];
    const latestCreditorPayment = (await client.query<SqlRow>(
      [
        "SELECT v.voucher_date::text AS payment_date,e.debit_amount::text AS payment_amount",
        "FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id",
        "WHERE e.company_id=$1 AND e.ledger_account_id=(SELECT id FROM ledger_accounts",
        "WHERE company_id=$1 AND code='WALMDACLE')",
        "AND v.company_id=$1 AND v.deleted_at IS NULL AND COALESCE(v.optional,false)=false",
        "AND e.debit_amount>0 AND v.description ILIKE '%WALID%'",
        "ORDER BY v.voucher_date DESC,v.id DESC LIMIT 1",
      ].join("\n"), [COMPANY]
    )).rows[0];
    const fiscalCloseEvidence = (await client.query<SqlRow>(
      "SELECT COUNT(*)::int AS reviewed_closures FROM accounting_fiscal_reviewed_closures WHERE company_id=$1",
      [COMPANY]
    )).rows[0];
    const charge64CreditorImpactPreview = previewCharge64CreditorImpact({
      creditorAccountCode: String(creditor.code),
      creditorAccountType: String(creditor.account_type),
      creditorPostedDebitUsd: String(creditor.posted_dr),
      creditorPostedCreditUsd: String(creditor.posted_cr),
      creditorOpeningBalanceUsd: String(creditor.opening_balance),
      creditorOpeningBalanceSide: creditor.opening_balance_side==null ? null : String(creditor.opening_balance_side),
      factoryClearingAccountCode: String(payableAccount.code),
      factoryClearingAccountType: String(payableAccount.accountType),
      factoryClearingPostedDebitUsd: String(payableAccount.debitUsd),
      daybookNativeAmountUsd: String(daybook64.amount_usd),
      retainedVoucherId: num(retainedCharge.id),
      retainedVoucherNativeAmountUsd: String(retainedCharge.total_amount),
      retainedCreditorCreditUsd: String(retainedCharge.creditor_credit),
      extraVoucherId: num(extraCharge.id),
      extraVoucherNativeAmountUsd: String(extraCharge.total_amount),
      extraCreditorCreditUsd: String(extraCharge.creditor_credit),
      priorCorrectionVoucherId: num(retiredCorrection.id),
      priorCorrectionDeletedAt: String(retiredCorrection.deleted_at),
      correctionDeletedAuditEventCount: num(audit64?.delete_events),
      correctionDeletionReason: audit64?.delete_reason == null ? null : String(audit64.delete_reason),
      originalAmountEditAuditEventCount: num(audit64?.amount_edits),
      latestCreditorPaymentDate: latestCreditorPayment?.payment_date == null ? null : String(latestCreditorPayment.payment_date),
      latestCreditorPaymentAmountUsd: latestCreditorPayment?.payment_amount == null ? null : String(latestCreditorPayment.payment_amount),
      fiscalReviewedCloseCount: num(fiscalCloseEvidence?.reviewed_closures),
    });

    const businessDate = factoryBusinessDateInBeirut(new Date());
    const lineageCoverage = {
      factoryBaleCount: num(baleLineage?.factory_bale_count),
      directlyMixLinkedBales: num(baleLineage?.direct_mix_links),
      pressingBatchLinkedBales: num(baleLineage?.pressing_links),
      linkedPressingBatches: num(pressingLinkCoverage?.n),
      inventoryCutoverApplied: cutovers.some((cutover) => String(cutover.status).toUpperCase() === "APPLIED"),
    };
    let totalGoods = money(0), totalCommissions = money(0), supplierCredit = money(0), supplierDebit = money(0);
    const vouchers = refs.map(({ id, kind, containerId, lines }) => {
      const container = containerMap.get(containerId);
      if (!container) throw new Error("Audited source container not found: " + containerId);
      const head = lines[0];
      const debits = lines.filter((l) => /expense/i.test(String(l.account_type ?? "")))
        .reduce((sum, line) => sum.plus(money(line.debit_usd)), money(0));
      const supplierCr = lines.filter((l) => l.factory_supplier_id != null)
        .reduce((sum, line) => sum.plus(money(line.credit_usd)), money(0));
      const supplierDr = lines.filter((l) => l.factory_supplier_id != null)
        .reduce((sum, line) => sum.plus(money(line.debit_usd)), money(0));
      if (kind === "goods") totalGoods = totalGoods.plus(debits);
      else totalCommissions = totalCommissions.plus(debits);
      supplierCredit = supplierCredit.plus(supplierCr);
      supplierDebit = supplierDebit.plus(supplierDr);
      const raw = stockMap.get(containerId);
      const receipt = receiptMap.get(containerId);
      const sourceMix = kind === "goods" ? mixSourceMap.get(containerId) : undefined;
      const freight = kind === "goods" ? freightByContainer.get(containerId) : undefined;
      const additionalImport = kind === "goods" ? additionalImportByContainer.get(containerId) : undefined;
      const freightOffsetReview = kind === "goods" ? classifyFreightOffsetEvidence({
        containerId,
        freightVoucherCount: num(freight?.freight_voucher_count),
        freightSourceAccountCodes: freight?.source_account_codes == null ? undefined : String(freight.source_account_codes),
        freightDebitUsd: String(freight?.freight_dr ?? "0"),
        freightCreditUsd: String(freight?.freight_cr ?? "0"),
        chargeClearingDebitUsd: String(freight?.clearing_dr ?? "0"),
        duplicateImportVoucherCount: num(additionalImport?.extra_vouchers),
        duplicateImportExpenseUsd: String(additionalImport?.extra_expense_usd ?? "0"),
      }) : null;
      const other = relatedExpense.get(containerId) ?? [];
      const expectedNative = kind === "goods"
        ? money(container.total_kg).times(money(container.rate_per_kg))
        : money(container.commission_amount);
      const sourceCurrency = String(kind === "goods" ? container.currency_code ?? "USD" :
        container.commission_currency_code ?? container.currency_code ?? "USD").toUpperCase();
      const containerCurrency = String(container.currency_code ?? "USD").toUpperCase();
      const expectedSourceFx = sourceCurrency === "USD" ? money(1)
        : sourceCurrency === containerCurrency && container.fx_rate_to_usd != null
          ? money(container.fx_rate_to_usd) : null;
      const expectedUsd = expectedSourceFx == null ? null : fixed(expectedNative.times(expectedSourceFx));
      const linkedSupplierLine = lines.find((line) => line.factory_supplier_id != null);
      const linkedSupplierId = linkedSupplierLine?.factory_supplier_id ?? null;
      const expectedSupplierId = kind === "goods" ? container.supplier_id : container.commission_supplier_id;
      const totalDebit = lines.reduce((sum, line) => sum.plus(money(line.debit_usd)), money(0));
      const totalCredit = lines.reduce((sum, line) => sum.plus(money(line.credit_usd)), money(0));
      const costAllocationPreview = previewHistoricalCostAllocation({
        kind,
        sourceMixCount: num(sourceMix?.source_mix_count),
        sourceMixWeightKg: String(sourceMix?.source_mix_weight_kg ?? "0"),
        sourceMixCostUsd: String(sourceMix?.source_mix_cost_usd ?? "0"),
        rawRemainingKg: String(raw?.remaining_kg ?? "0"),
        rawRemainingValueUsd: num(raw?.unvalued_raw_rows) > 0 ? null : String(raw?.remaining_value_usd ?? "0"),
        rawOverusedKg: String(raw?.overused_kg ?? "0"),
        rawUnvaluedRows: num(raw?.unvalued_raw_rows),
      }, lineageCoverage);
      const flags = classifyHistoricalSupplierVoucher({
        voucherDate: head.voucher_date,
        postingDate: head.recorded_at.slice(0, 10),
        businessDate,
        expenseDebitUsd: fixed(debits),
        supplierCreditUsd: fixed(supplierCr),
        expectedUsd,
        expectedSupplierId,
        linkedSupplierId,
        sourceCurrency,
        voucherCurrency: head.currency,
        voucherDebitsUsd: fixed(totalDebit),
        voucherCreditsUsd: fixed(totalCredit),
        storedArrivalDate: container.arrival_date,
        firstOffloadedAt: raw?.first_offloaded_at == null ? null : String(raw.first_offloaded_at),
        receivedKg: String(raw?.received_kg ?? "0"),
        usedKg: String(raw?.used_kg ?? "0"),
        remainingKg: String(raw?.remaining_kg ?? "0"),
        overusedKg: String(raw?.overused_kg ?? "0"),
        unvaluedRawRows: num(raw?.unvalued_raw_rows),
        relatedExpenseCount: other.length,
      });
      return {
        voucherId: id,
        voucherNumber: head.voucher_number,
        kind, containerId, containerNumber: container.container_number,
        supplierId: linkedSupplierId,
        supplierName: linkedSupplierLine?.supplier_name ?? null,
        sourceSupplierId: expectedSupplierId,
        sourceSupplierName: kind === "goods" ? container.supplier_name : container.commission_supplier_name,
        sourceGoodsSupplierId: container.supplier_id,
        sourceGoodsSupplierName: container.supplier_name,
        voucherDate: head.voucher_date, postedAt: head.recorded_at,
        storedArrivalDate: container.arrival_date,
        containerCreatedDate: container.created_on,
        containerStatus: container.status,
        currency: head.currency, exchangeRate: head.exchange_rate,
        sourceCurrency,
        sourceNativeAmount: fixed(expectedNative),
        sourceExpectedUsd: expectedUsd,
        voucherTotalDebitUsd: fixed(totalDebit),
        voucherTotalCreditUsd: fixed(totalCredit),
        expenseDebitUsd: fixed(debits),
        supplierDebitUsd: fixed(supplierDr),
        supplierCreditUsd: fixed(supplierCr),
        receivedKg: String(raw?.received_kg ?? "0"),
        usedKg: String(raw?.used_kg ?? "0"),
        remainingKg: String(raw?.remaining_kg ?? "0"),
        overusedKg: String(raw?.overused_kg ?? "0"),
        remainingRawValueUsd: num(raw?.unvalued_raw_rows) > 0 ? null : String(raw?.remaining_value_usd ?? "0"),
        unvaluedRawRows: num(raw?.unvalued_raw_rows),
        legacyQuantityKgNotValuation: String(raw?.legacy_quantity_kg ?? "0"),
        firstOffloadedAt: raw?.first_offloaded_at ?? null,
        receiptRecordCount: num(receipt?.receipt_count),
        firstReceiptDate: receipt?.first_receipt_date ?? null,
        lastReceiptDate: receipt?.last_receipt_date ?? null,
        otherFactoryExpenseLines: other.map((x) => ({
          voucherNumber: x.voucher_number, accountCode: x.account_code,
          debitUsd: x.debit_usd, creditUsd: x.credit_usd,
        })),
        costAllocationPreview,
        freightOffsetReview,
        flags,
        proposedCorrection: null,
        reviewStatus: "NOT_PROVEN_DO_NOT_POST",
      };
    });
    const report = {
      metadata: {
        companyId: COMPANY, generatedAtUtc: new Date().toISOString(),
        businessDateBeirut: businessDate,
        backendOnly: true, readOnly: true, transaction: "REPEATABLE READ READ ONLY",
        changesToSuppliers: "0.00", changesToGL: "0.00", changesToStock: "0.00",
      },
      totals: {
        goodsVouchers: EXPECTED_GOODS, commissionVouchers: EXPECTED_COMMISSIONS,
        goodsExpenseDebitUsd: fixed(totalGoods),
        commissionExpenseDebitUsd: fixed(totalCommissions),
        totalExpenseDebitUsd: fixed(totalGoods.plus(totalCommissions)),
        postedSupplierCreditsUsd: fixed(supplierCredit),
        postedSupplierDebitsUsd: fixed(supplierDebit),
        PROVEN_OVERSTATEMENT_USD: null,
      },
      perpetualInventoryEvidence: {
        cutovers,
        stockJournalCount: num(stockJournals[0]?.n),
        lineageCoverage,
        linkedMixSnapshot: {
          linkedMixCount: num(relatedMixSnapshot?.linked_mix_count),
          currentUnconsumedMixWeightKg: String(relatedMixSnapshot?.unconsumed_mix_weight_kg ?? "0"),
          currentMixWipValueUsd: String(relatedMixSnapshot?.mix_wip_value_usd ?? "0"),
          zeroCostMixCount: num(relatedMixSnapshot?.zero_cost_mix_count),
          attributableToIndividualContainers: false,
          warning: "Shared mixes may contain other supplier material. Current values are not historical sale-COGS proof.",
        },
      },
      accountClassificationAudit: {
        accounts: accountClassificationAudit,
        clearingPeriodNeutralityPreview,
        charge64CreditorImpactPreview,
        postOffloadSourceEvidence: {
          activePocVouchers: postOffloadSourceLinks.length,
          sourceMatched: postOffloadSourceLinks.filter((row) => row.status === "SOURCE_IDENTITY_MATCHED").length,
          requiresSourceReview: postOffloadSourceLinks.filter((row) => row.status !== "SOURCE_IDENTITY_MATCHED").length,
          sourceInventoryDeltaRecordedCount: postOffloadSourceLinks.filter((row) => row.recordedInventoryDeltaUsd != null).length,
          sourceInventoryDeltaIsRecognizedGLAsset: false,
          warning: "Native source amount and voucher amount must match before accounting interpretation. Old voucher link differences are not proven duplicated costs.",
          exceptions: postOffloadSourceLinks.filter((row) => row.status !== "SOURCE_IDENTITY_MATCHED"),
          duplicateSourceFamilies: duplicatePostOffloadSources,
          duplicateSourceFamiliesCount: duplicatePostOffloadSources.length,
          safeCorrectionAmountUsd: null,
          reviewWarning: "A source may have two active vouchers, even when charge.voucher_id points to only one. A retired correction is not an active offset. Creditor ledgers may change if adjusted; no automatic reversal permitted.",
        },
        typeMismatches: accountClassificationAudit.filter((account) => account.mismatch).length,
        financialImpactToReclassifyUsd: null,
        payableCounterpartBreakdown: payableCounterparts.map((row) => ({
          accountCode: row.account_code,
          accountType: row.account_type,
          vouchers: num(row.vouchers),
          debitUsd: String(row.debit_usd),
          creditUsd: String(row.credit_usd),
        })),
        warning: "Type mismatches are real reporting risks, not permission to rewrite source accounts or post supplier-neutral financial journals.",
      },
      alternativeProductionEvidence: {
        pressingConfirmationBales: num(supplementalLineage?.pressing_confirmation_bales),
        productionAttributionBales: num(supplementalLineage?.production_attribution_bales),
        historicalBaleRepairBales: num(supplementalLineage?.historical_bale_repair_bales),
        dailyUsageMixCount: num(supplementalLineage?.daily_usage_mix_count),
        posBaleLinkCount: num(supplementalLineage?.pos_bale_link_count),
        provesMixToBaleLineage: false,
        warning: "An alternative bale identity without a verified mix/source link cannot support sale COGS attribution.",
      },
      freightSourceReview: {
        checkedActiveFreightSourceVouchers: freightRows.reduce((sum,row) => sum + num(row.freight_voucher_count), 0),
        goodsContainersWithFreightEntries: freightRows.length,
        goodsContainersWithOtherImportVouchers: additionalImportRows.length,
        safeExpenseReversalUsd: null,
        warning: "Matched freight debits and credits do not certify which expenses or liabilities should be reversed.",
      },
      previewGate: {
        financialJournalPostingAllowed: false,
        supplierAndNamedCreditorBalancesFrozen: true,
        maximumAllowedSupplierOrCreditorDeltaUsd: "0.00",
        noSupplierOrCreditorVoucherLineAllowed: true,
        postOnlyAfterVerifiedOriginalCostAndNoncreditorOffset: false,
        charge64ReversalUnderBalanceFreeze: "BLOCKED_WALMDACLE_LEDGER_WOULD_CHANGE",
        safeVerifiedOverstatementUsd: null,
        reason: "No complete historical source-to-finished-bale or sale cost lineage and no proved historical GL capitalization.",
      },
      safeguards: [
        "Read-only inspection cannot alter existing supplier balances or accounting.",
        "A matching expense description is NOT proof of duplicate COGS.",
        "Already consumed materials must NOT be capitalized as current stock.",
        "Supplier-party balances AND named creditor ledger balances (including WALMDACLE) must not change.",
        "No historical --apply backfill: source supplier amounts were posted in October 2026.",
        "Do not debit WALMDACLE to reverse charge #64 under the current supplier/creditor balance freeze.",
        "Only independently proven non-supplier, non-creditor GL-only journals could be reviewed; none is currently approved.",
        "No corrective journal amount or offset account is inferred automatically.",
      ],
      vouchers,
    };
    await client.query("COMMIT");
    committed = true;
    return report;
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

if (process.argv[1]?.includes("audit-historical-factory-suppliers-20261102")) {
  if (process.argv.slice(2).length) {
    throw new Error("Read-only audit accepts no arguments; --apply/--fix are prohibited");
  }
  void auditHistoricalFactorySuppliers()
    .then((result) => { process.stdout.write(JSON.stringify(result, null, 2) + "\n"); })
    .catch((error: unknown) => { console.error("[HistoricalSupplierAudit] " + String(error)); process.exitCode = 1; })
    .finally(() => pool.end());
}
