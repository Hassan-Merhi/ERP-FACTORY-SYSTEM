/**
 * Phase 7: explicitly approved historical cost-center assignments.
 *
 * Preview writes a time-limited ANALYTICAL plan only; apply inserts allocation
 * tags and audit records in one transaction. Neither endpoint creates or edits
 * GL vouchers, cash/bank, supplier balances, containers, factory stock or FX.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { requireAuth } from "../auth";
import {
  getActiveCompanyPermissionContext,
  ActiveCompanyPermissionContextError,
} from "../services/security/activeCompanyPermissionContext";
import { MoneyDecimal, sumMoney, toMoney } from "../lib/money";
import { reversalPairSql } from "./costCenterReportingRoutes";

type SourceKind = "VOUCHER_ENTRY" | "FACTORY_DAYBOOK";
type Entry = {
  sourceId: number;
  voucherId: number | null;
  voucherNumber: string | null;
  sourceDate: string;
  currency: string;
  amountNative: string;
  amountUsd: string;
  historicalRate: string | null;
  rateConvention: string | null;
  accountName: string;
  accountCode: string | null;
  sourceModule: string;
};
type PlanSplit = { costCenterId: number; percent: string };
type Plan = {
  sourceKind: SourceKind;
  fromDate: string;
  toDate: string;
  ledgerAccountId: number | null;
  limit: number;
  splits: PlanSplit[];
  reason: string;
};
type Actor = { companyId: number; userId: string; role: string; username: string };
class HistoryError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const rolesRead = new Set(["Admin", "Owner", "Developer", "Manager"]);
const rolesWrite = new Set(["Admin", "Owner", "Developer"]);
const idSchema = z.coerce.number().int().positive().max(2147483647);
const amountPattern = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const previewBody = z
  .object({
    sourceKind: z.enum(["VOUCHER_ENTRY", "FACTORY_DAYBOOK"]),
    fromDate: z.string(),
    toDate: z.string(),
    ledgerAccountId: idSchema.nullable().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    splits: z
      .array(
        z
          .object({
            costCenterId: idSchema,
            percent: z.string().regex(amountPattern),
          })
          .strict()
      )
      .min(1)
      .max(10),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

async function actor(req: Request, write = false): Promise<Actor> {
  const ctx = await getActiveCompanyPermissionContext(req);
  if (!(write ? rolesWrite : rolesRead).has(ctx.role))
    throw new HistoryError(403, "Cost center accounting permission required");
  return {
    companyId: ctx.companyId,
    userId: ctx.userId,
    role: ctx.role,
    username: String(req.session.username || ctx.userId),
  };
}
function errorResponse(res: Response, e: unknown) {
  if (e instanceof HistoryError) return res.status(e.status).json({ message: e.message });
  if (e instanceof ActiveCompanyPermissionContextError)
    return res.status(e.status).json({ message: e.message, code: e.code });
  if (e && typeof e === "object") {
    const code = String((e as { code?: string }).code || "");
    if (code === "42P01")
      return res
        .status(503)
        .json({ message: "Cost centers are not installed yet", code: "COST_CENTERS_NOT_INSTALLED" });
    if (["23503", "23505", "23514", "P0001", "40001"].includes(code))
      return res.status(409).json({ message: "Historical allocation conflicts with a changed or protected source" });
  }
  logger.error("Cost center historical request failed", { module: "cost-centers", error: e });
  return res.status(500).json({ message: "Historical cost center operation failed" });
}
function validDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function windowDates(from: string, to: string): void {
  if (!validDate(from) || !validDate(to) || from > to)
    throw new HistoryError(400, "Enter a valid historical date range");
  if (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z") > 366 * 5 * 86400000)
    throw new HistoryError(400, "Narrow the date range to five years or less");
}
function parsePlan(raw: unknown): Plan {
  const parsed = previewBody.safeParse(raw);
  if (!parsed.success) throw new HistoryError(400, parsed.error.issues.map((i) => i.message).join("; "));
  const p = parsed.data;
  windowDates(p.fromDate, p.toDate);
  if (p.sourceKind === "FACTORY_DAYBOOK" && p.ledgerAccountId != null)
    throw new HistoryError(400, "Factory daybook entries do not have ledger account filters");
  if (new Set(p.splits.map((s) => s.costCenterId)).size !== p.splits.length)
    throw new HistoryError(400, "Each cost center can appear only once");
  const total = sumMoney(p.splits.map((s) => s.percent));
  if (total.lte(0) || total.gt(100) || p.splits.some((s) => toMoney(s.percent).lte(0)))
    throw new HistoryError(400, "Positive split percentages must total 100% or less");
  return {
    sourceKind: p.sourceKind,
    fromDate: p.fromDate,
    toDate: p.toDate,
    ledgerAccountId: p.ledgerAccountId ?? null,
    limit: p.limit,
    splits: p.splits.map((s) => ({ costCenterId: s.costCenterId, percent: toMoney(s.percent).toFixed(4) })),
    reason: p.reason.trim(),
  };
}
function queryParams(plan: Pick<Plan, "fromDate" | "toDate" | "ledgerAccountId" | "limit">, companyId: number) {
  return [companyId, plan.fromDate, plan.toDate, plan.ledgerAccountId, plan.limit + 1];
}
function sourceSql(kind: SourceKind): string {
  if (kind === "VOUCHER_ENTRY")
    return [
      'SELECT ve.id AS "sourceId",v.id AS "voucherId",v.voucher_number AS "voucherNumber",',
      ' COALESCE(v.effective_date,v.voucher_date)::text AS "sourceDate",',
      " COALESCE(ve.transaction_currency,v.currency,'USD') AS currency,",
      " GREATEST(abs(COALESCE(ve.transaction_debit_amount,ve.debit_amount,0)),",
      ' abs(COALESCE(ve.transaction_credit_amount,ve.credit_amount,0)))::text AS "amountNative",',
      " GREATEST(abs(COALESCE(ve.base_debit_amount,ve.debit_amount,0)),",
      ' abs(COALESCE(ve.base_credit_amount,ve.credit_amount,0)))::text AS "amountUsd",',
      ' ve.historical_exchange_rate::text AS "historicalRate",',
      ' ve.rate_convention AS "rateConvention",l.name AS "accountName",',
      ' l.code AS "accountCode",COALESCE(v.source_module,\'ERP\') AS "sourceModule"',
      " FROM voucher_entries ve JOIN vouchers v ON v.id=ve.voucher_id AND v.company_id=ve.company_id",
      " JOIN ledger_accounts l ON l.id=ve.ledger_account_id AND l.company_id=ve.company_id",
      " WHERE ve.company_id=$1 AND v.deleted_at IS NULL AND v.optional=false",
      " AND NOT " + reversalPairSql("v"),
      " AND v.voucher_number NOT LIKE 'GC-%' AND v.voucher_number NOT LIKE 'MIG-%'",
      " AND upper(COALESCE(v.source_module,'')) NOT LIKE 'INTERCOMPANY%'",
      " AND COALESCE(v.source_module,'') <> 'SP_MIGRATION_READONLY'",
      " AND upper(btrim(l.account_type)) IN ('EXPENSE','DIRECT EXPENSE','INDIRECT EXPENSE')",
      " AND ve.debit_amount>0 AND COALESCE(ve.credit_amount,0)=0",
      " AND COALESCE(ve.transaction_debit_amount,ve.debit_amount,0)>0",
      " AND GREATEST(abs(COALESCE(ve.base_debit_amount,ve.debit_amount,0)),",
      " abs(COALESCE(ve.base_credit_amount,ve.credit_amount,0)))>=0",
      " AND COALESCE(v.effective_date,v.voucher_date) BETWEEN $2::date AND $3::date",
      " AND ($4::integer IS NULL OR ve.ledger_account_id=$4)",
      " AND NOT EXISTS(SELECT 1 FROM cost_center_allocations a",
      " WHERE a.company_id=ve.company_id AND a.voucher_entry_id=ve.id)",
      " AND NOT EXISTS(SELECT 1 FROM cost_center_source_overrides o",
      " WHERE o.company_id=ve.company_id AND o.voucher_entry_id=ve.id)",
      " ORDER BY COALESCE(v.effective_date,v.voucher_date),ve.id LIMIT $5",
    ].join(" ");
  return [
    'SELECT f.id AS "sourceId",NULL::integer AS "voucherId",',
    ' NULL::varchar AS "voucherNumber",COALESCE(f.effective_date,f.tx_date)::text AS "sourceDate",',
    ' f.currency_code AS currency,abs(f.amount_currency)::text AS "amountNative",',
    ' abs(f.amount_usd)::text AS "amountUsd",f.fx_rate_to_usd::text AS "historicalRate",',
    " 'BASE_PER_TRANSACTION'::text AS \"rateConvention\",",
    " 'Standalone Factory Daybook'::text AS \"accountName\",",
    ' NULL::text AS "accountCode",\'FACTORY\'::text AS "sourceModule"',
    " FROM factory_daybook_entries f WHERE f.company_id=$1",
    " AND f.tx_type IN ('EXPENSE','OPERATING_EXPENSE','FACTORY_EXPENSE')",
    " AND f.amount_currency>0 AND f.amount_usd>=0",
    " AND f.reference_id IS NULL AND NULLIF(btrim(COALESCE(f.reference_table,'')),'') IS NULL",
    " AND COALESCE(f.effective_date,f.tx_date) BETWEEN $2::date AND $3::date AND $4::integer IS NULL",
    " AND NOT EXISTS(SELECT 1 FROM cost_center_allocations a",
    " WHERE a.company_id=f.company_id AND a.factory_daybook_entry_id=f.id)",
    " AND NOT EXISTS(SELECT 1 FROM cost_center_source_overrides o",
    " WHERE o.company_id=f.company_id AND o.factory_daybook_entry_id=f.id)",
    " ORDER BY COALESCE(f.effective_date,f.tx_date),f.id LIMIT $5",
  ].join(" ");
}
async function candidates(client: PoolClient, companyId: number, plan: Plan): Promise<Entry[]> {
  const result = await client.query(sourceSql(plan.sourceKind), queryParams(plan, companyId));
  return result.rows as Entry[];
}
function digest(rows: Entry[]): string {
  // PG JSONB reorders object keys; use a fixed, ordered evidence tuple so a
  // stored preview hashes identically to the live source read at apply time.
  const tuples = rows.map((row) => [
    row.sourceId,
    row.voucherId,
    row.voucherNumber,
    row.sourceDate,
    row.currency,
    row.amountNative,
    row.amountUsd,
    row.historicalRate,
    row.rateConvention,
    row.accountName,
    row.accountCode,
    row.sourceModule,
  ]);
  return createHash("sha256").update(JSON.stringify(tuples)).digest("hex");
}
function calculate(rows: Entry[], splits: PlanSplit[]) {
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
async function assertActiveCenters(client: PoolClient, companyId: number, splits: PlanSplit[]) {
  const ids = splits.map((s) => s.costCenterId);
  const res = await client.query(
    "SELECT id FROM cost_centers WHERE company_id=$1 AND active=true" + " AND id=ANY($2::integer[]) FOR SHARE",
    [companyId, ids]
  );
  if (res.rowCount !== ids.length)
    throw new HistoryError(409, "All destination cost centers must be active and belong to the selected company");
}
async function inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
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
async function audit(
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
function parseUuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value))
    throw new HistoryError(400, "Invalid historical preview ID");
  return value;
}
function parseFilters(req: Request): {
  sourceKind: SourceKind;
  fromDate: string;
  toDate: string;
  ledgerAccountId: number | null;
} {
  const sourceKind = req.query.sourceKind;
  if (sourceKind !== "VOUCHER_ENTRY" && sourceKind !== "FACTORY_DAYBOOK")
    throw new HistoryError(400, "Choose a historical source kind");
  if (typeof req.query.fromDate !== "string" || typeof req.query.toDate !== "string")
    throw new HistoryError(400, "Date range required");
  windowDates(req.query.fromDate, req.query.toDate);
  const parsedId =
    req.query.ledgerAccountId === undefined
      ? ({ success: true, data: null } as const)
      : idSchema.safeParse(req.query.ledgerAccountId);
  if (!parsedId.success) throw new HistoryError(400, "Invalid expense account filter");
  const ledgerAccountId = parsedId.data;
  if (sourceKind === "FACTORY_DAYBOOK" && ledgerAccountId !== null)
    throw new HistoryError(400, "Factory daybook cannot be filtered by account");
  return { sourceKind, fromDate: req.query.fromDate, toDate: req.query.toDate, ledgerAccountId };
}

function registerPrefix(app: Express, prefix: string) {
  // Non-mutating reconciliation of eligible posted expense debits only.
  // This is NOT an entire general-ledger/P&L reconciliation.
  app.get(prefix + "/historical/reconciliation", requireAuth, async (req, res) => {
    try {
      const current = await actor(req);
      const filter = parseFilters(req);
      if (filter.sourceKind === "FACTORY_DAYBOOK" && prefix !== "/api/factory/cost-centers")
        throw new HistoryError(403, "Factory Daybook history is available only in Factory Mode");
      // Keep ALL eligible sources for reconciliation, including assigned and
      // manually cleared ones. Candidate discovery deliberately excludes them;
      // a reconciliation must not. The source SQL is joined with arbitrary
      // whitespace, so match the full predicate rather than raw substrings.
      const sql = sourceSql(filter.sourceKind)
        .replace(
          /\s+AND NOT EXISTS\(SELECT 1 FROM cost_center_allocations a\s+WHERE a\.company_id=(?:ve|f)\.company_id AND a\.(?:voucher_entry_id=ve\.id|factory_daybook_entry_id=f\.id)\)/,
          ""
        )
        .replace(
          /\s+AND NOT EXISTS\(SELECT 1 FROM cost_center_source_overrides o\s+WHERE o\.company_id=(?:ve|f)\.company_id AND o\.(?:voucher_entry_id=ve\.id|factory_daybook_entry_id=f\.id)\)/,
          ""
        )
        .replace(/\s+LIMIT \$5\s*$/, "");
      const response = await pool.query(
        "WITH eligible AS (" +
          sql +
          ') SELECT count(*)::int AS "sourceCount",COALESCE(sum(e."amountUsd"::numeric),0)::text AS "postedUsd", ' +
          'COALESCE(sum(COALESCE(a.allocated,0)),0)::text AS "allocatedUsd",' +
          'COALESCE(sum(GREATEST(e."amountUsd"::numeric-COALESCE(a.allocated,0),0)),0)::text AS "unallocatedUsd",' +
          'count(*) FILTER(WHERE COALESCE(a.allocated,0)>e."amountUsd"::numeric)::int AS "overallocatedSources",' +
          'count(*) FILTER(WHERE COALESCE(a.allocated,0)>0)::int AS "allocatedSources" ' +
          "FROM eligible e LEFT JOIN LATERAL (SELECT sum(cca.amount_base) AS allocated" +
          " FROM cost_center_allocations cca WHERE cca.company_id=$1 AND " +
          (filter.sourceKind === "VOUCHER_ENTRY"
            ? 'cca.voucher_entry_id=e."sourceId"'
            : 'cca.factory_daybook_entry_id=e."sourceId"') +
          ") a ON true",
        [current.companyId, filter.fromDate, filter.toDate, filter.ledgerAccountId]
      );
      // Native currency controls are independent of the historical USD
      // book-value controls; amounts of different currencies are never summed.
      const native = await pool.query(
        "WITH eligible AS (" +
          sql +
          ") SELECT e.currency," +
          'count(*)::int AS "sourceCount",' +
          'COALESCE(sum(e."amountNative"::numeric),0)::text AS "sourceNative",' +
          'COALESCE(sum(COALESCE(a.allocated_native,0)),0)::text AS "allocatedNative",' +
          'COALESCE(sum(GREATEST(e."amountNative"::numeric-COALESCE(a.allocated_native,0),0)),0)::text AS "unallocatedNative",' +
          'count(*) FILTER (WHERE COALESCE(a.allocated_native,0)>e."amountNative"::numeric)::int AS "overallocatedSources"' +
          " FROM eligible e LEFT JOIN LATERAL (" +
          " SELECT sum(cca.amount_native) AS allocated_native FROM cost_center_allocations cca" +
          " WHERE cca.company_id=$1 AND " +
          (filter.sourceKind === "VOUCHER_ENTRY"
            ? 'cca.voucher_entry_id=e."sourceId"'
            : 'cca.factory_daybook_entry_id=e."sourceId"') +
          ") a ON true GROUP BY e.currency ORDER BY e.currency",
        [current.companyId, filter.fromDate, filter.toDate, filter.ledgerAccountId]
      );
      res.json({
        kind: filter.sourceKind,
        period: filter,
        basis: "eligible_posted_expense_debits_only",
        ...response.rows[0],
        nativeCurrencies: native.rows,
      });
    } catch (e) {
      errorResponse(res, e);
    }
  });

  app.post(prefix + "/historical/preview", requireAuth, async (req, res) => {
    try {
      const current = await actor(req, true);
      const plan = parsePlan(req.body);
      if (plan.sourceKind === "FACTORY_DAYBOOK" && prefix !== "/api/factory/cost-centers")
        throw new HistoryError(403, "Factory Daybook history is available only in Factory Mode");
      const preview = await inTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(721031,$1)", [current.companyId]);
        await assertActiveCenters(client, current.companyId, plan.splits);
        const matched = await candidates(client, current.companyId, plan);
        if (matched.length > plan.limit)
          throw new HistoryError(
            413,
            "More eligible entries than the batch limit; narrow the dates/account before preview"
          );
        if (!matched.length)
          throw new HistoryError(404, "No unallocated eligible expense debits matched these filters");
        const calculated = calculate(matched, plan.splits);
        const batchId = randomUUID();
        const hash = digest(matched);
        await client.query(
          "INSERT INTO cost_center_historical_batches" +
            "(id,company_id,created_by,source_kind,request_snapshot,source_snapshot," +
            "source_hash,candidate_count,candidate_native_total,candidate_usd_total,expires_at)" +
            " VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,now() + interval '20 minutes')",
          [
            batchId,
            current.companyId,
            current.userId,
            plan.sourceKind,
            JSON.stringify(plan),
            JSON.stringify(matched),
            hash,
            matched.length,
            calculated.sourceNativeTotal,
            calculated.sourceUsdTotal,
          ]
        );
        await audit(client, current, "create", "history-preview:" + batchId, null, {
          batchId,
          sourceKind: plan.sourceKind,
          filters: plan,
          candidateCount: matched.length,
          amountUsd: calculated.sourceUsdTotal,
        });
        return {
          batchId,
          status: "PREVIEW",
          expiresInMinutes: 20,
          candidateCount: matched.length,
          sourceHash: hash,
          sourceNativeTotal: calculated.sourceNativeTotal,
          sourceUsdTotal: calculated.sourceUsdTotal,
          allocatedNativeTotal: calculated.allocatedNativeTotal,
          allocatedUsdTotal: calculated.allocatedUsdTotal,
          rows: calculated.rows,
          warning: "DRY RUN ONLY — no historical allocations or accounting entries have changed",
        };
      });
      res.status(201).json(preview);
    } catch (e) {
      errorResponse(res, e);
    }
  });

  app.post(prefix + "/historical/:batchId/apply", requireAuth, async (req, res) => {
    try {
      const current = await actor(req, true);
      const batchId = parseUuid(req.params.batchId);
      if (req.body?.confirmation !== "APPLY") throw new HistoryError(400, "Explicit APPLY confirmation is required");
      const result = await inTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(721031,$1)", [current.companyId]);
        const found = await client.query(
          "SELECT * FROM cost_center_historical_batches WHERE company_id=$1 AND id=$2 FOR UPDATE",
          [current.companyId, batchId]
        );
        if (!found.rowCount) throw new HistoryError(404, "Historical preview not found");
        const batch = found.rows[0];
        if (batch.created_by !== current.userId)
          throw new HistoryError(403, "Only the original preview author may apply this batch");
        if (batch.status !== "PREVIEW") throw new HistoryError(409, "Historical preview was already applied");
        if (new Date(batch.expires_at).getTime() <= Date.now())
          throw new HistoryError(409, "Historical preview expired; create a new dry run");
        const plan = parsePlan(batch.request_snapshot);
        const previous = batch.source_snapshot as Entry[];
        if (digest(previous) !== batch.source_hash || previous.length !== batch.candidate_count)
          throw new HistoryError(409, "Stored dry-run snapshot was altered");
        await assertActiveCenters(client, current.companyId, plan.splits);
        // Hold source and parent voucher locks before rechecking live facts.
        for (const original of previous) {
          if (plan.sourceKind === "VOUCHER_ENTRY") {
            const entryLock = await client.query(
              "SELECT id,voucher_id FROM voucher_entries WHERE company_id=$1 AND id=$2 FOR SHARE",
              [current.companyId, original.sourceId]
            );
            if (!entryLock.rowCount) throw new HistoryError(409, "An expense source was removed");
            await client.query("SELECT id FROM vouchers WHERE company_id=$1 AND id=$2 FOR SHARE", [
              current.companyId,
              entryLock.rows[0].voucher_id,
            ]);
          } else {
            const lock = await client.query(
              "SELECT id FROM factory_daybook_entries WHERE company_id=$1 AND id=$2 FOR SHARE",
              [current.companyId, original.sourceId]
            );
            if (!lock.rowCount) throw new HistoryError(409, "A Factory expense source was removed");
          }
        }
        const currentRows = await candidates(client, current.companyId, plan);
        if (currentRows.length !== previous.length || digest(currentRows) !== batch.source_hash)
          throw new HistoryError(
            409,
            "A source, amount, date or allocation changed since preview; start another dry run"
          );
        const calculated = calculate(currentRows, plan.splits);
        if (
          !toMoney(calculated.sourceNativeTotal).eq(batch.candidate_native_total) ||
          !toMoney(calculated.sourceUsdTotal).eq(batch.candidate_usd_total)
        )
          throw new HistoryError(409, "Historical source controls no longer match the preview");
        if (plan.sourceKind === "FACTORY_DAYBOOK" && prefix !== "/api/factory/cost-centers")
          throw new HistoryError(403, "Factory Daybook history is available only in Factory Mode");
        const sourceColumn = plan.sourceKind === "VOUCHER_ENTRY" ? "voucher_entry_id" : "factory_daybook_entry_id";
        for (const item of calculated.rows) {
          // Claim the source with an override so future automatic defaults
          // cannot later overwrite or re-create these manually approved tags.
          await client.query(
            "INSERT INTO cost_center_source_overrides(company_id," +
              sourceColumn +
              ",reason,overridden_by) VALUES($1,$2,$3,$4)",
            [current.companyId, item.sourceId, plan.reason, current.userId]
          );
          for (const split of item.allocations) {
            await client.query(
              "INSERT INTO cost_center_allocations" +
                "(company_id,cost_center_id," +
                sourceColumn +
                "," +
                "amount_native,currency,amount_base,base_currency,historical_rate," +
                "rate_convention,cost_treatment,allocation_origin,created_by,updated_by)" +
                " VALUES($1,$2,$3,$4,$5,$6,'USD',$7,$8,'EXPENSE','MANUAL',$9,$9)",
              [
                current.companyId,
                split.costCenterId,
                item.sourceId,
                split.amountNative,
                item.currency,
                split.amountUsd,
                item.historicalRate,
                item.rateConvention,
                current.userId,
              ]
            );
          }
          const native = sumMoney(item.allocations.map((s) => s.amountNative)).toFixed(6);
          const usd = sumMoney(item.allocations.map((s) => s.amountUsd)).toFixed(6);
          await client.query(
            "INSERT INTO cost_center_historical_batch_items" +
              "(batch_id,company_id,source_kind,source_id,source_native,source_usd," +
              "allocated_native,allocated_usd,applied_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              batchId,
              current.companyId,
              plan.sourceKind,
              item.sourceId,
              item.amountNative,
              item.amountUsd,
              native,
              usd,
              current.userId,
            ]
          );
          await client.query(
            "INSERT INTO audit_log" +
              "(user_id,username,company_id,action,table_name,record_id,record_identifier,changes)" +
              " VALUES($1,$2,$3,'create','cost_center_allocations',NULL,$4,$5::jsonb)",
            [
              current.userId,
              current.username,
              current.companyId,
              "history:" + batchId + ":" + plan.sourceKind + ":" + item.sourceId,
              JSON.stringify({
                snapshot: { old: [], new: item.allocations },
                reason: plan.reason,
                sourceNative: item.amountNative,
                sourceUsd: item.amountUsd,
              }),
            ]
          );
        }
        await client.query(
          "UPDATE cost_center_historical_batches SET status='APPLIED'," +
            "applied_by=$3,applied_at=now() WHERE company_id=$1 AND id=$2",
          [current.companyId, batchId, current.userId]
        );
        await audit(
          client,
          current,
          "update",
          "history-applied:" + batchId,
          { status: "PREVIEW", sourceHash: batch.source_hash },
          {
            status: "APPLIED",
            sources: calculated.rows.length,
            allocatedNative: calculated.allocatedNativeTotal,
            allocatedUsd: calculated.allocatedUsdTotal,
          }
        );
        return {
          batchId,
          status: "APPLIED",
          sourceCount: calculated.rows.length,
          allocatedNativeTotal: calculated.allocatedNativeTotal,
          allocatedUsdTotal: calculated.allocatedUsdTotal,
          message: "Historical analytical allocation committed; original accounting records unchanged",
        };
      });
      res.json(result);
    } catch (e) {
      errorResponse(res, e);
    }
  });

  app.get(prefix + "/historical/batches", requireAuth, async (req, res) => {
    try {
      const current = await actor(req);
      const rows = await pool.query(
        'SELECT id,status,source_kind AS "sourceKind",candidate_count AS "candidateCount",' +
          'candidate_native_total::text AS "sourceNativeTotal",' +
          'candidate_usd_total::text AS "sourceUsdTotal",' +
          'created_by AS "createdBy",created_at AS "createdAt",expires_at AS "expiresAt",' +
          'applied_by AS "appliedBy",applied_at AS "appliedAt",' +
          'request_snapshot AS "request"' +
          " FROM cost_center_historical_batches WHERE company_id=$1" +
          " ORDER BY created_at DESC LIMIT 50",
        [current.companyId]
      );
      res.json({ batches: rows.rows });
    } catch (e) {
      errorResponse(res, e);
    }
  });

  app.get(prefix + "/historical/:batchId", requireAuth, async (req, res) => {
    try {
      const current = await actor(req);
      const batchId = parseUuid(req.params.batchId);
      const batch = await pool.query(
        'SELECT id,status,source_kind AS "sourceKind",candidate_count AS "candidateCount",' +
          'source_hash AS "sourceHash",request_snapshot AS "request",' +
          'source_snapshot AS "sources",created_by AS "createdBy",' +
          'created_at AS "createdAt",expires_at AS "expiresAt",' +
          'applied_at AS "appliedAt",applied_by AS "appliedBy"' +
          " FROM cost_center_historical_batches WHERE company_id=$1 AND id=$2",
        [current.companyId, batchId]
      );
      if (!batch.rowCount) throw new HistoryError(404, "Historical batch not found");
      const items = await pool.query(
        'SELECT source_kind AS "sourceKind",source_id AS "sourceId",' +
          'source_native::text AS "sourceNative",source_usd::text AS "sourceUsd",' +
          'allocated_native::text AS "allocatedNative",allocated_usd::text AS "allocatedUsd"' +
          " FROM cost_center_historical_batch_items WHERE company_id=$1 AND batch_id=$2" +
          " ORDER BY source_id LIMIT 100",
        [current.companyId, batchId]
      );
      res.json({ batch: batch.rows[0], items: items.rows });
    } catch (e) {
      errorResponse(res, e);
    }
  });
}
export function registerCostCenterHistoricalRoutes(app: Express) {
  registerPrefix(app, "/api/cost-centers");
  registerPrefix(app, "/api/factory/cost-centers");
}
