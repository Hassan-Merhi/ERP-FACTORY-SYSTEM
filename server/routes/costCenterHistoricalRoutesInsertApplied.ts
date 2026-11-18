// Extracted from ./costCenterHistoricalRoutes.ts to keep that module under the source-size cap.
import type { PoolClient } from "pg";
import { pool } from "../db";
import { MoneyDecimal, sumMoney, toMoney } from "../lib/money";
import {
  HistoryError,
  type Actor,
  type Entry,
  type Plan,
  type PlanSplit,
  type SourceKind,
} from "./costCenterHistoricalRoutesSourceSql";

export function calculate(rows: Entry[], splits: PlanSplit[]) {
  const detail = rows.map((row) => {
    const native = toMoney(row.amountNative),
      usd = toMoney(row.amountUsd);
    if (native.lte(0) || usd.lt(0)) throw new HistoryError(409, "Eligible source has an invalid historical amount");
    if (
      !row.currency ||
      !row.currency.trim() ||
      row.currency.length > 10 ||
      (row.historicalRate != null && toMoney(row.historicalRate).lte(0))
    )
      throw new HistoryError(409, "Historical currency or source FX evidence is invalid; source not modified");
    const allocations = splits.map((s) => ({
      costCenterId: s.costCenterId,
      // Round down so the splits of a 100% plan can never exceed the source.
      amountNative: native.times(s.percent).div(100).toDecimalPlaces(6, MoneyDecimal.ROUND_DOWN).toFixed(6),
      amountUsd: usd.times(s.percent).div(100).toDecimalPlaces(6, MoneyDecimal.ROUND_DOWN).toFixed(6),
    }));
    if (
      allocations.some((s) => toMoney(s.amountNative).lte(0)) ||
      sumMoney(allocations.map((x) => x.amountNative)).gt(native) ||
      sumMoney(allocations.map((x) => x.amountUsd)).gt(usd)
    )
      throw new HistoryError(409, "Split produces zero/overallocated source amounts; adjust the percentages or scope");
    return { ...row, allocations };
  });
  return {
    rows: detail,
    sourceNativeTotal: sumMoney(detail.map((row) => row.amountNative)).toFixed(6),
    sourceUsdTotal: sumMoney(detail.map((row) => row.amountUsd)).toFixed(6),
    allocatedNativeTotal: sumMoney(detail.flatMap((row) => row.allocations.map((a) => a.amountNative))).toFixed(6),
    allocatedUsdTotal: sumMoney(detail.flatMap((row) => row.allocations.map((a) => a.amountUsd))).toFixed(6),
  };
}

export async function assertActiveCenters(client: PoolClient, companyId: number, splits: PlanSplit[]) {
  const ids = splits.map((s) => s.costCenterId);
  const res = await client.query(
    "SELECT id FROM cost_centers WHERE company_id=$1 AND active=true" + " AND id=ANY($2::integer[]) FOR SHARE",
    [companyId, ids]
  );
  if (res.rowCount !== ids.length)
    throw new HistoryError(409, "All destination cost centers must be active and belong to the selected company");
}

export async function inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function audit(
  client: PoolClient,
  actor: Actor,
  action: "create" | "update",
  identifier: string,
  before: unknown,
  after: unknown
) {
  await client.query(
    "INSERT INTO audit_log(user_id,username,company_id,action,table_name,record_id,record_identifier,changes)" +
      " VALUES($1,$2,$3,$4,'cost_center_historical_batches',NULL,$5,$6::jsonb)",
    [
      actor.userId,
      actor.username,
      actor.companyId,
      action,
      identifier,
      JSON.stringify({ snapshot: { old: before, new: after } }),
    ]
  );
}

export async function lockSources(client: PoolClient, companyId: number, kind: SourceKind, sources: Entry[]) {
  const ids = sources.map((row) => row.sourceId);
  if (kind === "VOUCHER_ENTRY") {
    const entries = await client.query(
      "SELECT id,voucher_id FROM voucher_entries WHERE company_id=$1 AND id=ANY($2::integer[]) ORDER BY id FOR SHARE",
      [companyId, ids]
    );
    if (entries.rowCount !== ids.length) throw new HistoryError(409, "An expense source was removed");
    const voucherIds = Array.from(new Set(entries.rows.map((row) => Number(row.voucher_id))));
    await client.query("SELECT id FROM vouchers WHERE company_id=$1 AND id=ANY($2::integer[]) ORDER BY id FOR SHARE", [
      companyId,
      voucherIds,
    ]);
    return;
  }
  const lock = await client.query(
    "SELECT id FROM factory_daybook_entries WHERE company_id=$1 AND id=ANY($2::integer[]) ORDER BY id FOR SHARE",
    [companyId, ids]
  );
  if (lock.rowCount !== ids.length) throw new HistoryError(409, "A Factory expense source was removed");
}

type CalculatedRow = ReturnType<typeof calculate>["rows"][number];

/**
 * Set-based writes for an approved batch (up to HISTORICAL_BATCH_MAX sources):
 * one statement per table instead of one per source, so large batches commit
 * quickly. Row triggers on the analytical tables still validate every row.
 */
export async function insertApplied(
  client: PoolClient,
  actor: Actor,
  batchId: string,
  plan: Plan,
  rows: CalculatedRow[]
) {
  const sourceColumn = plan.sourceKind === "VOUCHER_ENTRY" ? "voucher_entry_id" : "factory_daybook_entry_id";
  // Claim the sources with overrides so future automatic defaults cannot
  // later overwrite or re-create these manually approved tags.
  await client.query(
    "INSERT INTO cost_center_source_overrides(company_id," +
      sourceColumn +
      ",reason,overridden_by) SELECT $1,s,$3,$4 FROM unnest($2::integer[]) AS s",
    [actor.companyId, rows.map((row) => row.sourceId), plan.reason, actor.userId]
  );
  const splits = rows.flatMap((row) => row.allocations.map((split) => ({ row, split })));
  await client.query(
    "INSERT INTO cost_center_allocations" +
      "(company_id,cost_center_id," +
      sourceColumn +
      ",amount_native,currency,amount_base,base_currency,historical_rate," +
      "rate_convention,cost_treatment,allocation_origin,created_by,updated_by)" +
      " SELECT $1,x.cc,x.src,x.nat::numeric,x.cur,x.usd::numeric,'USD',x.rate::numeric,x.conv," +
      "'EXPENSE','MANUAL',$2,$2" +
      " FROM unnest($3::integer[],$4::integer[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[])" +
      " AS x(cc,src,nat,cur,usd,rate,conv)",
    [
      actor.companyId,
      actor.userId,
      splits.map(({ split }) => split.costCenterId),
      splits.map(({ row }) => row.sourceId),
      splits.map(({ split }) => split.amountNative),
      splits.map(({ row }) => row.currency),
      splits.map(({ split }) => split.amountUsd),
      splits.map(({ row }) => row.historicalRate),
      splits.map(({ row }) => row.rateConvention),
    ]
  );
  await client.query(
    "INSERT INTO cost_center_historical_batch_items" +
      "(batch_id,company_id,source_kind,source_id,source_native,source_usd," +
      "allocated_native,allocated_usd,applied_by)" +
      " SELECT $1,$2,$3,x.src,x.snat::numeric,x.susd::numeric,x.anat::numeric,x.ausd::numeric,$4" +
      " FROM unnest($5::integer[],$6::text[],$7::text[],$8::text[],$9::text[]) AS x(src,snat,susd,anat,ausd)",
    [
      batchId,
      actor.companyId,
      plan.sourceKind,
      actor.userId,
      rows.map((row) => row.sourceId),
      rows.map((row) => row.amountNative),
      rows.map((row) => row.amountUsd),
      rows.map((row) => sumMoney(row.allocations.map((s) => s.amountNative)).toFixed(6)),
      rows.map((row) => sumMoney(row.allocations.map((s) => s.amountUsd)).toFixed(6)),
    ]
  );
  await client.query(
    "INSERT INTO audit_log(user_id,username,company_id,action,table_name,record_id,record_identifier,changes)" +
      " SELECT $1,$2,$3,'create','cost_center_allocations',NULL,x.ident,x.changes::jsonb" +
      " FROM unnest($4::text[],$5::text[]) AS x(ident,changes)",
    [
      actor.userId,
      actor.username,
      actor.companyId,
      rows.map((row) => "history:" + batchId + ":" + plan.sourceKind + ":" + row.sourceId),
      rows.map((row) =>
        JSON.stringify({
          snapshot: { old: [], new: row.allocations },
          reason: plan.reason,
          sourceNative: row.amountNative,
          sourceUsd: row.amountUsd,
        })
      ),
    ]
  );
}
