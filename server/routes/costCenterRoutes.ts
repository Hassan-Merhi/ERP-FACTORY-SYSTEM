/**
 * Cost-center Phase 2 API. Shared by ERP and Factory through two route prefixes.
 * These are analytical tags only; no financial journal or balance is posted.
 */
import type { Express } from "express";
import { pool } from "../db";
import { requireAuth } from "../auth";
import { toMoney, sumMoney } from "../lib/money";
import { sourceCte } from "./costCenterReportingRoutes";
import {
  ApiError,
  assertPrefixScope,
  audit,
  centerInCompany,
  editBody,
  fields,
  identity,
  pageQuery,
  parse,
  queryId,
  replaceBody,
  sendError,
  sourceColumn,
  sourceInCompany,
  sourceKinds,
  sourceTreatment,
  splitList,
  transaction,
} from "./costCenterRoutesSourceInCompany";
import { registerCostCenterPrefixPart1 } from "./registerCostCenterPrefixPart1";

function registerCostCenterPrefix(app: Express, prefix: string) {
  registerCostCenterPrefixPart1(app, prefix);
  registerCostCenterPrefixPart2(app, prefix);
}

export function registerCostCenterRoutes(app: Express): void {
  registerCostCenterPrefix(app, "/api/cost-centers");
  registerCostCenterPrefix(app, "/api/factory/cost-centers");
}

function registerCostCenterPrefixPart2(app: Express, prefix: string) {
  // A single atomic replace is the supported edit, split and remove operation.
  // It never modifies the original journal, voucher or factory daybook amount.
  app.put(prefix + "/allocations/:sourceType/:sourceId", requireAuth, async (req, res) => {
    try {
      const actor = await identity(req, true);
      const kind = parse(sourceKinds, req.params.sourceType);
      const sourceId = queryId(req.params.sourceId);
      const input = parse(replaceBody, req.body);
      assertPrefixScope(
        prefix,
        kind,
        input.splits.map((s) => s.costTreatment)
      );
      if (new Set(input.splits.map((s) => s.costCenterId)).size !== input.splits.length) {
        throw new ApiError(400, "Duplicate cost center in split");
      }
      const changed = await transaction(async (client) => {
        // Matches the DB trigger advisory key, blocking interleaved replacements.
        await client.query("SELECT pg_advisory_xact_lock(721031,$1)", [actor.companyId]);
        const source = await sourceInCompany(client, actor.companyId, kind, sourceId);
        const treatment = sourceTreatment(source, kind);
        if (input.splits.some((s) => s.costTreatment !== treatment)) {
          throw new ApiError(409, "Expense vs inventory classification must match the posted source");
        }
        const native = sumMoney(input.splits.map((s) => s.amountNative));
        const base = sumMoney(input.splits.map((s) => s.amountBase));
        const totalNative = toMoney(source.amountNative);
        const totalBase = toMoney(source.amountBase);
        if (native.gt(totalNative) || base.gt(totalBase)) throw new ApiError(409, "Split exceeds source amount");
        // Require proportional historical currency valuation, except for
        // permitted 6dp rounding. Prevent arbitrary client-submitted USD values.
        if (totalNative.lte(0) || totalBase.lt(0)) throw new ApiError(409, "Source has no allocatable amount");
        const tolerance = toMoney("0.000001").times(input.splits.length + 1);
        for (const s of input.splits) {
          const expected = toMoney(s.amountNative).times(totalBase).dividedBy(totalNative);
          if (toMoney(s.amountBase).minus(expected).abs().gt(tolerance)) {
            throw new ApiError(409, "Historical USD allocation does not match source proportion");
          }
        }
        const ids = input.splits.map((s) => s.costCenterId);
        if (ids.length) {
          const selected = await client.query(
            "SELECT id FROM cost_centers WHERE company_id=$1 AND active=true AND id=ANY($2::int[]) FOR SHARE",
            [actor.companyId, ids]
          );
          if (selected.rows.length !== ids.length)
            throw new ApiError(409, "A split uses a missing or archived cost center");
        }
        // Explicit user changes, including CLEAR ALL, permanently take priority
        // over the deferred auto-allocation trigger.
        const overrideCol = sourceColumn(kind);
        await client.query("DELETE FROM cost_center_source_overrides WHERE company_id=$1 AND " + overrideCol + "=$2", [
          actor.companyId,
          sourceId,
        ]);
        await client.query(
          "INSERT INTO cost_center_source_overrides(company_id," +
            overrideCol +
            ",reason,overridden_by) VALUES($1,$2,$3,$4)",
          [actor.companyId, sourceId, input.reason, actor.userId]
        );
        const before = await splitList(client, actor.companyId, kind, sourceId);
        const column = sourceColumn(kind);
        await client.query("DELETE FROM cost_center_allocations WHERE company_id=$1 AND " + column + "=$2", [
          actor.companyId,
          sourceId,
        ]);
        for (const s of input.splits) {
          await client.query(
            "INSERT INTO cost_center_allocations " +
              "(company_id,cost_center_id," +
              column +
              ",amount_native,currency,amount_base,base_currency," +
              "historical_rate,rate_convention,cost_treatment,created_by,updated_by)" +
              " VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9,$10,$10)",
            [
              actor.companyId,
              s.costCenterId,
              sourceId,
              s.amountNative,
              source.currency,
              s.amountBase,
              source.historicalRate || null,
              source.rateConvention || null,
              s.costTreatment,
              actor.userId,
            ]
          );
        }
        const after = await splitList(client, actor.companyId, kind, sourceId);
        await audit(
          client,
          actor,
          after.length === 0 ? "delete" : before.length ? "update" : "create",
          "cost_center_allocations",
          null,
          kind + ":" + sourceId,
          { splits: before, reason: input.reason },
          { splits: after, reason: input.reason }
        );
        return {
          sourceType: kind,
          sourceId,
          splits: after,
          allocatedNative: native.toFixed(6),
          allocatedBase: base.toFixed(6),
          unallocatedNative: totalNative.minus(native).toFixed(6),
          unallocatedBase: totalBase.minus(base).toFixed(6),
        };
      });
      res.json(changed);
    } catch (e) {
      sendError(res, e);
    }
  });
  app.get(prefix + "/allocations/:sourceType/:sourceId/history", requireAuth, async (req, res) => {
    try {
      const { companyId } = await identity(req, false);
      const kind = parse(sourceKinds, req.params.sourceType);
      const id = queryId(req.params.sourceId);
      const limit = pageQuery(req.query.limit, 40, 100);
      const offset = pageQuery(req.query.offset, 0, 1000000);
      const result = await pool.query(
        'SELECT id,action,changes,username,created_at AS "createdAt" FROM audit_log' +
          " WHERE company_id=$1 AND table_name='cost_center_allocations' AND record_identifier=$2" +
          " ORDER BY id DESC LIMIT $3 OFFSET $4",
        [companyId, kind + ":" + id, limit, offset]
      );
      res.json({ history: result.rows });
    } catch (e) {
      sendError(res, e);
    }
  });
  app.patch(prefix + "/:id", requireAuth, async (req, res) => {
    try {
      const actor = await identity(req, true);
      const id = queryId(req.params.id);
      const changes = parse(editBody, req.body);
      if (!Object.keys(changes).length) throw new ApiError(400, "No changes supplied");
      const result = await transaction(async (client) => {
        const before = await centerInCompany(client, actor.companyId, id, true);
        const next = { ...before, ...changes };
        if (next.parentId != null) {
          const parent = await centerInCompany(client, actor.companyId, Number(next.parentId), true);
          if (!parent.active) throw new ApiError(409, "Parent center is archived");
        }
        const row = await client.query(
          "UPDATE cost_centers SET code=$3,name=$4,description=$5,parent_id=$6,active=$7," +
            "updated_by=$8,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING " +
            fields,
          [actor.companyId, id, next.code, next.name, next.description, next.parentId, next.active, actor.userId]
        );
        await audit(client, actor, "update", "cost_centers", id, String(next.code), before, row.rows[0]);
        return row.rows[0];
      });
      res.json({ costCenter: result });
    } catch (e) {
      sendError(res, e);
    }
  });
  app.post(prefix + "/:id/archive", requireAuth, async (req, res) => {
    try {
      const actor = await identity(req, true);
      const id = queryId(req.params.id);
      const result = await transaction(async (client) => {
        const before = await centerInCompany(client, actor.companyId, id, true);
        if (before.active) {
          const child = await client.query(
            "SELECT 1 FROM cost_centers WHERE company_id=$1 AND parent_id=$2 AND active=true LIMIT 1",
            [actor.companyId, id]
          );
          if (child.rows.length) throw new ApiError(409, "Archive active child centers first");
        }
        const row = await client.query(
          "UPDATE cost_centers SET active=false,updated_by=$3,updated_at=now()" +
            " WHERE company_id=$1 AND id=$2 RETURNING " +
            fields,
          [actor.companyId, id, actor.userId]
        );
        await audit(client, actor, "update", "cost_centers", id, String(before.code), before, row.rows[0]);
        return row.rows[0];
      });
      res.json({ costCenter: result });
    } catch (e) {
      sendError(res, e);
    }
  });
  app.get(prefix + "/:id", requireAuth, async (req, res) => {
    try {
      const { companyId } = await identity(req, false);
      const id = queryId(req.params.id);
      const client = await pool.connect();
      try {
        res.json({ costCenter: await centerInCompany(client, companyId, id) });
      } finally {
        client.release();
      }
    } catch (e) {
      sendError(res, e);
    }
  });
  app.get(prefix + "/:id/activity", requireAuth, async (req, res) => {
    try {
      const { companyId } = await identity(req, false);
      const id = queryId(req.params.id);
      const limit = pageQuery(req.query.limit, 50, 100);
      const offset = pageQuery(req.query.offset, 0, 1000000);
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      const fromDate = req.query.fromDate;
      const toDate = req.query.toDate;
      if (fromDate !== undefined && (typeof fromDate !== "string" || !datePattern.test(fromDate))) {
        throw new ApiError(400, "Invalid activity start date");
      }
      if (toDate !== undefined && (typeof toDate !== "string" || !datePattern.test(toDate))) {
        throw new ApiError(400, "Invalid activity end date");
      }
      const result = await transaction(async (client) => {
        const center = await centerInCompany(client, companyId, id);
        // Same eligibility, reversal exclusion and credit sign as the reports,
        // so the center page reconciles with the budget/expense report.
        const entries = await client.query(
          sourceCte +
            [
              ' SELECT s.allocation_id AS id,s.voucher_id AS "voucherId",s.voucher_entry_id AS "voucherEntryId",',
              's.factory_daybook_entry_id AS "factoryDaybookEntryId",',
              's.signed_native::text AS "amountNative",s.signed_usd::text AS "amountBase",',
              's.currency,s.cost_treatment AS "costTreatment",s.allocation_origin AS "allocationOrigin",',
              's.source_date::text AS "sourceDate",s.voucher_number AS "voucherNumber",f.tx_type AS "factoryTxType"',
              "FROM filtered s LEFT JOIN factory_daybook_entries f ON f.id=s.factory_daybook_entry_id",
              "AND f.company_id=s.company_id",
              "ORDER BY s.source_date DESC,s.allocation_id DESC LIMIT $7 OFFSET $8",
            ].join(" "),
          [[companyId], fromDate || "0001-01-01", toDate || "9999-12-31", id, null, "ALL", limit, offset]
        );
        return { center, activity: entries.rows };
      });
      res.json(result);
    } catch (e) {
      sendError(res, e);
    }
  });
  app.get(prefix + "/:id/balance", requireAuth, async (req, res) => {
    try {
      const { companyId } = await identity(req, false);
      const id = queryId(req.params.id);
      const result = await transaction(async (client) => {
        const center = await centerInCompany(client, companyId, id);
        const grouped = await client.query(
          sourceCte +
            ' SELECT cost_treatment AS "costTreatment",sum(signed_usd)::text AS "amountBase",' +
            ' count(*)::int AS "entryCount" FROM filtered GROUP BY cost_treatment ORDER BY cost_treatment',
          [[companyId], "0001-01-01", "9999-12-31", id, null, "ALL"]
        );
        return { center, baseCurrency: "USD", byTreatment: grouped.rows };
      });
      res.json(result);
    } catch (e) {
      sendError(res, e);
    }
  });
  app.get(prefix + "/:id/history", requireAuth, async (req, res) => {
    try {
      const { companyId } = await identity(req, false);
      const id = queryId(req.params.id);
      const result = await pool.query(
        'SELECT id,action,changes,username,created_at AS "createdAt" FROM audit_log' +
          " WHERE company_id=$1 AND table_name='cost_centers' AND record_id=$2 ORDER BY id DESC LIMIT 100",
        [companyId, id]
      );
      res.json({ history: result.rows });
    } catch (e) {
      sendError(res, e);
    }
  });
}
