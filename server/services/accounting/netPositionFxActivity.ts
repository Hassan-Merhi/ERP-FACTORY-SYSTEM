/**
 * Read-only evidence timeline for the Net Position Unrealized FX rows.
 *
 * Unrealized FX is a live valuation projection, NOT a posted voucher.
 * This endpoint returns persisted voucher, rate and (Factory-only) supplier
 * activity so users can trace the underlying native-currency records.
 * It deliberately does not invent historical daily FX profits from rates
 * without a provable date-scoped monetary balance.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";

export type FxActivityKind = "voucher" | "rate" | "container" | "supplier_payment" | "supplier_transfer";
export interface FxActivityEntry {
  id: string;
  kind: FxActivityKind;
  date: string;
  recordedAt: string | null;
  reference: string;
  description: string;
  currency: string;
  nativeAmount: string | null;
  usdAmount: string | null;
  rate: string | null;
  voucherId: number | null;
  sourceKey: string | null;
}
export interface NetPositionFxActivity {
  companyId: number;
  mode: "erp" | "factory";
  entries: FxActivityEntry[];
  truncated: boolean;
  notes: string[];
}

type RawEvent = Record<string, unknown> & {
  id: number | string;
  date: string;
  recorded_at: string | null;
  reference: string | null;
  description: string | null;
  currency: string | null;
  native_amount: string | null;
  usd_amount: string | null;
  rate: string | null;
  voucher_id: number | null;
  source_key: string | null;
};

function normalize(kind: FxActivityKind, rows: RawEvent[]): FxActivityEntry[] {
  return rows.map((row) => ({
    id: `${kind}:${row.id}`,
    kind,
    date: String(row.date).slice(0, 10),
    recordedAt: row.recorded_at == null ? null : String(row.recorded_at),
    reference: String(row.reference ?? ""),
    description: String(row.description ?? ""),
    currency: String(row.currency ?? "").trim().toUpperCase(),
    nativeAmount: row.native_amount == null ? null : String(row.native_amount),
    usdAmount: row.usd_amount == null ? null : String(row.usd_amount),
    rate: row.rate == null ? null : String(row.rate),
    voucherId: row.voucher_id == null ? null : Number(row.voucher_id),
    sourceKey: row.source_key == null ? null : String(row.source_key),
  }));
}

function permittedDate(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(value + "T00:00:00Z")) ||
      new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid history date. Use YYYY-MM-DD.");
  }
  return value;
}

export async function loadNetPositionFxActivity(input: {
  companyId: number;
  factory: boolean;
  from?: unknown;
  to?: unknown;
}): Promise<NetPositionFxActivity> {
  const from = permittedDate(input.from);
  const to = permittedDate(input.to);
  if (from && to && from > to) throw new Error("History start date must be on or before end date.");
  const companyId = input.companyId;
  // One capped query per source. No historical master balances are rewritten;
  // the dates below describe REAL persisted source events, not daily FX P&L.
  const voucherEvents = db.execute(sql`
    SELECT ve.id,
      COALESCE(v.effective_date, v.voucher_date)::text AS date,
      v.created_at::text AS recorded_at,
      COALESCE(v.voucher_number, 'Voucher #' || v.id::text) AS reference,
      COALESCE(NULLIF(ve.narration, ''), v.description, 'Foreign-currency voucher') AS description,
      UPPER(COALESCE(NULLIF(TRIM(ve.transaction_currency), ''), v.currency, 'USD')) AS currency,
      CASE
        WHEN ve.transaction_debit_amount IS NOT NULL AND ve.transaction_credit_amount IS NOT NULL
        THEN (ve.transaction_debit_amount::numeric - ve.transaction_credit_amount::numeric)::text
        ELSE NULL
      END AS native_amount,
      (COALESCE(ve.debit_amount, 0)::numeric - COALESCE(ve.credit_amount, 0)::numeric)::text AS usd_amount,
      ve.historical_exchange_rate::text AS rate,
      v.id AS voucher_id,
      CASE
        WHEN ve.ledger_account_id IS NOT NULL THEN 'ledger:' || ve.ledger_account_id::text
        WHEN ve.bank_account_id IS NOT NULL THEN 'bank:' || ve.bank_account_id::text
        WHEN ve.customer_id IS NOT NULL THEN 'customer:' || ve.customer_id::text
        ELSE NULL
      END AS source_key
    FROM voucher_entries ve
    JOIN vouchers v ON v.id = ve.voucher_id
    WHERE v.company_id = ${companyId}
      AND v.deleted_at IS NULL AND v.optional = false
      AND (UPPER(COALESCE(ve.transaction_currency, v.currency, 'USD')) <> 'USD')
      ${from ? sql`AND COALESCE(v.effective_date, v.voucher_date) >= ${from}::date` : sql``}
      ${to ? sql`AND COALESCE(v.effective_date, v.voucher_date) <= ${to}::date` : sql``}
    ORDER BY COALESCE(v.effective_date, v.voucher_date) DESC, ve.id DESC
    LIMIT 201
  `);

  const rateEvents = input.factory
    ? db.execute(sql`
        SELECT id, effective_date::text AS date, created_at::text AS recorded_at,
          currency_code || ' rate' AS reference,
          'Factory saved FX rate (USD per foreign unit)' AS description,
          UPPER(currency_code) AS currency,
          NULL::text AS native_amount, NULL::text AS usd_amount,
          rate_to_usd::text AS rate, NULL::integer AS voucher_id,
          NULL::text AS source_key
        FROM factory_fx_rates
        WHERE company_id = ${companyId} AND source = 'manual'
        ${from ? sql`AND effective_date >= ${from}::date` : sql``}
        ${to ? sql`AND effective_date <= ${to}::date` : sql``}
        ORDER BY effective_date DESC, id DESC LIMIT 201
      `)
    : db.execute(sql`
        SELECT id, effective_date::text AS date, NULL::text AS recorded_at,
          from_currency || ' → ' || to_currency AS reference,
          'Saved accounting FX rate (quoted currency pair)' AS description,
          UPPER(to_currency) AS currency,
          NULL::text AS native_amount, NULL::text AS usd_amount,
          rate::text AS rate, NULL::integer AS voucher_id,
          NULL::text AS source_key
        FROM exchange_rates
        WHERE company_id = ${companyId}
          AND (UPPER(from_currency) = 'USD' OR UPPER(to_currency) = 'USD')
          ${from ? sql`AND effective_date >= ${from}::date` : sql``}
          ${to ? sql`AND effective_date <= ${to}::date` : sql``}
        ORDER BY effective_date DESC, id DESC LIMIT 201
      `);

  const factoryEvents: Array<Promise<unknown>> = input.factory ? [
    db.execute(sql`
      SELECT fc.id,
        COALESCE(fc.arrival_date::date, fc.created_at::date)::text AS date,
        fc.created_at::text AS recorded_at,
        fc.container_number AS reference,
        'Container ' || COALESCE(fc.status, '') || ' — ' || COALESCE(fs.name, 'Supplier') AS description,
        UPPER(fc.currency_code) AS currency,
        (COALESCE(fc.total_kg, 0)::numeric * COALESCE(fc.rate_per_kg, 0)::numeric)::text AS native_amount,
        fc.final_payable_amount_usd::text AS usd_amount,
        fc.fx_rate_to_usd::text AS rate,
        NULL::integer AS voucher_id,
        'supplier:' || fc.supplier_id::text AS source_key
      FROM factory_containers fc
      LEFT JOIN factory_suppliers fs ON fs.id = fc.supplier_id AND fs.company_id = fc.company_id
      WHERE fc.company_id = ${companyId} AND fc.deleted_at IS NULL
        AND UPPER(COALESCE(fc.currency_code, 'USD')) <> 'USD'
        ${from ? sql`AND COALESCE(fc.arrival_date::date, fc.created_at::date) >= ${from}::date` : sql``}
        ${to ? sql`AND COALESCE(fc.arrival_date::date, fc.created_at::date) <= ${to}::date` : sql``}
      ORDER BY COALESCE(fc.arrival_date::date, fc.created_at::date) DESC, fc.id DESC LIMIT 201
    `),
    db.execute(sql`
      SELECT p.id, p.date::text AS date, NULL::text AS recorded_at,
        'Supplier payment #' || p.id::text AS reference,
        'Supplier settlement' AS description,
        UPPER(p.currency_code) AS currency,
        (-p.amount::numeric)::text AS native_amount,
        NULL::text AS usd_amount,
        p.fx_rate_to_usd::text AS rate,
        NULL::integer AS voucher_id, 'supplier:' || p.supplier_id::text AS source_key
      FROM factory_supplier_payments p
      WHERE p.company_id = ${companyId}
        AND UPPER(COALESCE(p.currency_code, 'USD')) <> 'USD'
        ${from ? sql`AND p.date >= ${from}::date` : sql``}
        ${to ? sql`AND p.date <= ${to}::date` : sql``}
      ORDER BY p.date DESC, p.id DESC LIMIT 201
    `),
    db.execute(sql`
      SELECT t.id, t.date::text AS date, NULL::text AS recorded_at,
        'Supplier FX transfer #' || t.id::text AS reference,
        'Supplier foreign-currency settlement/conversion' AS description,
        UPPER(t.from_currency_code) AS currency,
        (-t.from_amount::numeric)::text AS native_amount,
        t.to_amount_usd::text AS usd_amount,
        t.fx_rate_to_usd::text AS rate,
        NULL::integer AS voucher_id,
        'supplier:' || t.from_supplier_id::text AS source_key
      FROM factory_supplier_fx_transfers t
      WHERE t.company_id = ${companyId}
        AND UPPER(COALESCE(t.from_currency_code, 'USD')) <> 'USD'
        ${from ? sql`AND t.date >= ${from}::date` : sql``}
        ${to ? sql`AND t.date <= ${to}::date` : sql``}
      ORDER BY t.date DESC, t.id DESC LIMIT 201
    `)
  ] : [];

  const [voucherResult, rateResult, ...factoryResults] = await Promise.all([
    voucherEvents, rateEvents, ...factoryEvents,
  ]);
  const voucherRows = resultRows(voucherResult) as RawEvent[];
  const rateRows = resultRows(rateResult) as RawEvent[];
  const byKind = ["container", "supplier_payment", "supplier_transfer"] as const;
  const activity = [
    ...normalize("voucher", voucherRows.slice(0, 200)),
    ...normalize("rate", rateRows.slice(0, 200)),
    ...factoryResults.flatMap((value, index) =>
      normalize(byKind[index], (resultRows(value as Parameters<typeof resultRows>[0]) as RawEvent[]).slice(0, 200))),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

  return {
    companyId,
    mode: input.factory ? "factory" : "erp",
    entries: activity.slice(0, 300),
    truncated: activity.length > 300 || voucherRows.length > 200 || rateRows.length > 200 ||
      factoryResults.some((result) => resultRows(result as Parameters<typeof resultRows>[0]).length > 200),
    notes: [
      "Unrealized FX is recalculated from outstanding balances at the selected reporting rate. It is not a posted voucher.",
      "The timeline contains recorded voucher, rate and supplier events, not reconstructed daily profit/loss snapshots.",
      "Only transactions with stored foreign-currency evidence and relevant source records appear; historical opening balances and legacy gaps may not have individual vouchers.",
    ],
  };
}
