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
        "COALESCE(SUM(quantity_kg),0)::text AS remaining_kg,",
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

    const businessDate = factoryBusinessDateInBeirut(new Date());
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
        firstOffloadedAt: raw?.first_offloaded_at ?? null,
        receiptRecordCount: num(receipt?.receipt_count),
        firstReceiptDate: receipt?.first_receipt_date ?? null,
        lastReceiptDate: receipt?.last_receipt_date ?? null,
        otherFactoryExpenseLines: other.map((x) => ({
          voucherNumber: x.voucher_number, accountCode: x.account_code,
          debitUsd: x.debit_usd, creditUsd: x.credit_usd,
        })),
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
      },
      safeguards: [
        "Read-only inspection cannot alter existing supplier balances or accounting.",
        "A matching expense description is NOT proof of duplicate COGS.",
        "Already consumed materials must NOT be capitalized as current stock.",
        "Only approved, fully evidenced GL-only journals could correct accounting; no supplier lines.",
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
