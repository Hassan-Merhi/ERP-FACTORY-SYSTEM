// Extracted from ./unpostedMemo.ts
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { resolveStoredFxRate } from "../../factory/currencyConversion";
import {
  MEMO_NO_RATE_LABEL,
  MEMO_SOURCE_LABELS,
  bookedBy,
  dateCut,
  idList,
  liveVoucherExists,
  rowsOf,
  type ContainerMemoRow,
  type Executor,
  type MemoQuery,
  type MemoSource,
  type PartyBalanceMemoLine,
} from "./unpostedMemoCustomerMemoRows";

/** USD per unit of `currency` when known: 1 for USD, a confirmed positive stored rate otherwise. */
function confirmedRate(currency: string, rate: string | null, confirmed: boolean | null): Decimal | null {
  if (currency === "USD") return new MoneyDecimal(1);
  if (!confirmed || rate === null) return null;
  const value = toMoney(rate);
  return value.greaterThan(0) ? value : null;
}

/** Same freight rule as isSupplierPaidFreight (factory/suppliers/_supplierStatementHelpers.ts). */
function supplierPaidFreight(row: ContainerMemoRow): boolean {
  if (row.freight_paid_by === "own") return false;
  if (row.freight_paid_by === "supplier") return true;
  const offloaded = ["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"].includes(String(row.status ?? "").toUpperCase());
  return offloaded ? row.freight_supplier_id !== null : true;
}

interface HeldCommissionRow {
  source: "factoryRawStockCommission" | "factoryCommissionRecord";
  source_id: number;
  party_id: number;
  container_number: string;
  date: string;
  currency_code: string | null;
  fx_rate_to_usd: string | null;
  fx_rate_confirmed: boolean | null;
  commission_amount: string | null;
  commission_currency: string | null;
  commission_rate: string | null;
  commission_rate_confirmed: boolean | null;
}

/** Commission held on raw-stock rows or commission records that no journal carries (wave 14). */
function heldCommissionRows(executor: Executor, query: MemoQuery) {
  const { companyId, ids, asOf } = query;
  const day = sql`COALESCE(NULLIF(BTRIM(fc.arrival_date::text), '')::date, fc.created_at::date)`;
  return rowsOf<HeldCommissionRow>(
    executor,
    sql`
      SELECT 'factoryRawStockCommission' AS source, rs.id AS source_id,
             COALESCE(rs.commission_supplier_id, fc.supplier_id) AS party_id,
             fc.container_number, ${day}::text AS date,
             fc.currency_code, fc.fx_rate_to_usd::text AS fx_rate_to_usd, fc.fx_rate_confirmed,
             rs.commission_amount::text AS commission_amount, rs.commission_currency_code AS commission_currency,
             rs.commission_fx_rate_to_usd::text AS commission_rate, NULL::boolean AS commission_rate_confirmed
        FROM factory_raw_stock rs
        JOIN factory_containers fc ON fc.id = rs.container_id AND fc.company_id = rs.company_id
       WHERE rs.company_id = ${companyId} AND rs.deleted_at IS NULL AND fc.deleted_at IS NULL
         AND COALESCE(rs.commission_amount, 0) > 0 AND COALESCE(fc.commission_amount, 0) <= 0
         AND COALESCE(rs.commission_supplier_id, fc.supplier_id) IN (${idList(ids)})
         AND NOT ${liveVoucherExists(
           (n) => sql`(${n} = 'FACTORY-COMM-' || fc.id::text OR ${n} LIKE 'FACTORY-COMM-' || fc.id::text || '-%')`,
           sql`fc.company_id`,
           asOf
         )}
         ${dateCut(day, asOf)}
      UNION ALL
      SELECT 'factoryCommissionRecord' AS source, cc.id AS source_id,
             COALESCE(fc.commission_supplier_id, fc.supplier_id) AS party_id,
             fc.container_number, ${day}::text AS date,
             fc.currency_code, fc.fx_rate_to_usd::text AS fx_rate_to_usd, fc.fx_rate_confirmed,
             cc.commission_total::text AS commission_amount, cc.currency_code AS commission_currency,
             cc.fx_rate_to_usd::text AS commission_rate, cc.fx_rate_confirmed AS commission_rate_confirmed
        FROM factory_container_commissions cc
        JOIN factory_containers fc ON fc.id = cc.container_id AND fc.company_id = cc.company_id
       WHERE cc.company_id = ${companyId} AND fc.deleted_at IS NULL
         AND COALESCE(fc.commission_amount, 0) <= 0
         AND COALESCE(fc.commission_supplier_id, fc.supplier_id) IN (${idList(ids)})
         ${dateCut(day, asOf)}
    `
  );
}

export async function factorySupplierMemoLines(executor: Executor, query: MemoQuery) {
  const { companyId, ids, asOf } = query;
  const day = sql`COALESCE(NULLIF(BTRIM(fc.arrival_date::text), '')::date, fc.created_at::date)`;
  const containers = await rowsOf<ContainerMemoRow>(
    executor,
    sql`
      -- The container of every FACTORY-IMPORT/FREIGHT/COMM-{container}[-…]
      -- voucher, parsed once: a per-container LIKE on a computed prefix scans
      -- every voucher of the company for each container and posting kind.
      WITH container_vouchers AS MATERIALIZED (
        SELECT m[1] AS kind, m[2]::int AS container_id, m[3] <> '' AS suffixed
          FROM (SELECT regexp_match(mv.voucher_number, '^FACTORY-(IMPORT|FREIGHT|COMM)-([0-9]+)((?:-.*)?)$') AS m
                  FROM vouchers mv
                 WHERE mv.company_id = ${companyId} AND mv.deleted_at IS NULL AND mv.optional = false
                   AND mv.voucher_number LIKE 'FACTORY-%'${bookedBy("mv", asOf)}) parsed
         WHERE m IS NOT NULL
      )
      SELECT fc.id, fc.container_number, fc.supplier_id,
             COALESCE(fc.commission_supplier_id, fc.supplier_id) AS commission_party_id,
             ${day}::text AS date, fc.status,
             fc.currency_code, fc.fx_rate_to_usd::text AS fx_rate_to_usd, fc.fx_rate_confirmed,
             (COALESCE(fc.total_kg, 0) * COALESCE(fc.rate_per_kg, 0))::text AS goods,
             EXISTS (SELECT 1 FROM container_vouchers cv
                      WHERE cv.container_id = fc.id AND cv.kind = 'IMPORT' AND cv.suffixed) AS goods_posted,
             (
               UPPER(COALESCE(fc.status, '')) = 'OPENING_BALANCE'
               AND UPPER(COALESCE(fc.currency_code, 'USD')) = 'USD'
               AND EXISTS (
                 SELECT 1 FROM factory_suppliers fs
                  WHERE fs.company_id = fc.company_id AND fs.id = fc.supplier_id
                    AND fs.opening_balance < 0
                    AND ABS(ABS(fs.opening_balance) -
                      COALESCE(fc.total_kg, 0) * COALESCE(fc.rate_per_kg, 0)) < 0.005
                    AND (
                      SELECT COUNT(*) FROM factory_containers opening
                       WHERE opening.company_id = fc.company_id AND opening.supplier_id = fc.supplier_id
                         AND opening.deleted_at IS NULL AND opening.status = 'OPENING_BALANCE'
                    ) = 1
               )
             ) AS opening_already_in_supplier_master,
             fc.freight::text AS freight, fc.freight_currency_code, fc.freight_fx_rate_to_usd::text AS freight_fx_rate_to_usd,
             fc.freight_fx_rate_confirmed, fc.freight_paid_by, fc.freight_supplier_id,
             EXISTS (SELECT 1 FROM container_vouchers cv
                      WHERE cv.container_id = fc.id AND cv.kind = 'FREIGHT') AS freight_posted,
             fc.commission_amount::text AS commission_amount, fc.commission_currency_code,
             fc.commission_fx_rate_to_usd::text AS commission_fx_rate_to_usd, fc.commission_fx_rate_confirmed,
             EXISTS (SELECT 1 FROM container_vouchers cv
                      WHERE cv.container_id = fc.id AND cv.kind = 'COMM') AS commission_posted
        FROM factory_containers fc
       WHERE fc.company_id = ${companyId} AND fc.deleted_at IS NULL
         AND (fc.supplier_id IN (${idList(ids)}) OR fc.commission_supplier_id IN (${idList(ids)}))
         ${dateCut(day, asOf)}
    `
  );

  const out: { partyId: number; line: PartyBalanceMemoLine }[] = [];
  const wanted = new Set(ids);
  const push = (row: ContainerMemoRow, source: MemoSource, native: Decimal, currency: string, rate: Decimal | null) => {
    const partyId = source === "factoryContainerCommission" ? row.commission_party_id : row.supplier_id;
    if (!partyId || !wanted.has(partyId) || !native.greaterThan(0)) return;
    const owed = native.negated();
    out.push({
      partyId,
      line: {
        source,
        reference: row.container_number,
        sourceId: row.id,
        date: row.date,
        amount: rate ? owed.times(rate).toFixed(2) : null,
        nativeAmount: owed.toFixed(2),
        currency,
        label: rate ? MEMO_SOURCE_LABELS[source] : MEMO_NO_RATE_LABEL,
        notInLedger: true,
      },
    });
  };

  for (const row of await heldCommissionRows(executor, query)) {
    const ccy = (row.currency_code || "USD").toUpperCase();
    const cccy = (row.commission_currency || ccy).toUpperCase();
    const containerRate = confirmedRate(ccy, row.fx_rate_to_usd, row.fx_rate_confirmed);
    let rate: Decimal | null;
    if (row.source === "factoryRawStockCommission") {
      // No confirmed flag on factory_raw_stock: the stored rate when it looks set.
      const own = resolveStoredFxRate(cccy, row.commission_rate);
      rate = own.looksSet
        ? cccy === "USD"
          ? new MoneyDecimal(1)
          : toMoney(row.commission_rate)
        : cccy === ccy
          ? containerRate
          : null;
    } else {
      rate = confirmedRate(cccy, row.commission_rate, row.commission_rate_confirmed);
    }
    const native = toMoney(row.commission_amount);
    if (!wanted.has(row.party_id) || !native.greaterThan(0)) continue;
    const owed = native.negated();
    out.push({
      partyId: row.party_id,
      line: {
        source: row.source,
        reference: row.container_number,
        sourceId: row.source_id,
        date: row.date,
        amount: rate ? owed.times(rate).toFixed(2) : null,
        nativeAmount: owed.toFixed(2),
        currency: cccy,
        label: rate ? MEMO_SOURCE_LABELS[row.source] : MEMO_NO_RATE_LABEL,
        notInLedger: true,
      },
    });
  }

  for (const row of containers) {
    const ccy = (row.currency_code || "USD").toUpperCase();
    const containerRate = confirmedRate(ccy, row.fx_rate_to_usd, row.fx_rate_confirmed);
    if (!row.goods_posted && !row.opening_already_in_supplier_master)
      push(row, "factoryContainerGoods", toMoney(row.goods), ccy, containerRate);
    if (!row.freight_posted && supplierPaidFreight(row)) {
      const fccy = (row.freight_currency_code || ccy).toUpperCase();
      const rate =
        fccy === ccy ? containerRate : confirmedRate(fccy, row.freight_fx_rate_to_usd, row.freight_fx_rate_confirmed);
      push(row, "factoryContainerFreight", toMoney(row.freight), fccy, rate);
    }
    if (!row.commission_posted) {
      const cccy = (row.commission_currency_code || ccy).toUpperCase();
      const rate =
        confirmedRate(cccy, row.commission_fx_rate_to_usd, row.commission_fx_rate_confirmed) ??
        (cccy === ccy ? containerRate : null);
      push(row, "factoryContainerCommission", toMoney(row.commission_amount), cccy, rate);
    }
  }
  return out;
}
