/**
 * Phase 7: explicitly approved historical cost-center assignments.
 *
 * Preview writes a time-limited ANALYTICAL plan only; apply inserts allocation
 * tags and audit records in one transaction. Neither endpoint creates or edits
 * GL vouchers, cash/bank, supplier balances, containers, factory stock or FX.
 */
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { pool } from "../db";
import { requireAuth } from "../auth";
import { toMoney } from "../lib/money";
import {
  HISTORICAL_BATCH_MAX,
  HistoryError,
  actor,
  candidates,
  digest,
  errorResponse,
  parsePlan,
  sourceSql,
  type Entry,
} from "./costCenterHistoricalRoutesSourceSql";
import {
  assertActiveCenters,
  audit,
  calculate,
  inTransaction,
  insertApplied,
  lockSources,
} from "./costCenterHistoricalRoutesInsertApplied";
import { parseUuid, parseFilters } from "./costCenterHistoricalRoutesHelpers";
export { HISTORICAL_BATCH_MAX } from "./costCenterHistoricalRoutesSourceSql";

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
        [current.companyId, filter.fromDate, filter.toDate, filter.ledgerAccountIds]
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
        [current.companyId, filter.fromDate, filter.toDate, filter.ledgerAccountIds]
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
            `More than ${plan.limit} eligible entries match; raise Maximum entries (up to ${HISTORICAL_BATCH_MAX}) or narrow the dates/accounts`
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
        await lockSources(client, current.companyId, plan.sourceKind, previous);
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
        await insertApplied(client, current, batchId, plan, calculated.rows);
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
