// Extracted from ./costCenterRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { pool } from "../db";
import { requireAuth } from "../auth";
import { sumMoney, toMoney } from "../lib/money";
import { reversalPairSql } from "./costCenterReportingRoutes";
import {
  ApiError,
  assertPrefixScope,
  audit,
  autoRuleSetBody,
  centerBody,
  centerInCompany,
  fields,
  identity,
  parse,
  queryId,
  sendError,
  sourceInCompany,
  sourceKinds,
  sourceTreatment,
  splitList,
  transaction,
} from "./costCenterRoutesSourceInCompany";

export function registerCostCenterPrefixPart1(app: Express, prefix: string) {
  app.get(prefix, requireAuth, async (req, res) => {
    try {
      const { companyId } = await identity(req, false);
      const includeArchived = req.query.includeArchived === "true";
      const result = await pool.query(
        "SELECT " +
          fields +
          " FROM cost_centers WHERE company_id=$1" +
          (includeArchived ? "" : " AND active=true") +
          " ORDER BY code,id LIMIT 2000",
        [companyId]
      );
      res.json({ costCenters: result.rows });
    } catch (e) {
      sendError(res, e);
    }
  });
  app.post(prefix, requireAuth, async (req, res) => {
    try {
      const actor = await identity(req, true);
      const input = parse(centerBody, req.body);
      const created = await transaction(async (client) => {
        if (input.parentId != null) {
          const parent = await centerInCompany(client, actor.companyId, input.parentId);
          if (!parent.active) throw new ApiError(409, "Parent center is archived");
        }
        const found = await client.query(
          "INSERT INTO cost_centers(company_id,code,name,description,parent_id,created_by,updated_by)" +
            " VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING " +
            fields,
          [actor.companyId, input.code, input.name, input.description || null, input.parentId || null, actor.userId]
        );
        await audit(client, actor, "create", "cost_centers", found.rows[0].id, input.code, null, found.rows[0]);
        return found.rows[0];
      });
      res.status(201).json({ costCenter: created });
    } catch (e) {
      sendError(res, e);
    }
  });
  // Read-only eligibility and current allocations for posted voucher expense lines.
  // This is intentionally source-of-truth based: no client supplied amounts,
  // company IDs, or inferred voucher totals.

  app.get(prefix + "/automation/accounts", requireAuth, async (req, res) => {
    try {
      const { companyId } = await identity(req, false);
      const result = await pool.query(
        'SELECT id,code,name,account_type AS "accountType" FROM ledger_accounts ' +
          "WHERE company_id=$1 AND active=true AND deleted_at IS NULL " +
          "AND upper(btrim(account_type)) IN ('EXPENSE','DIRECT EXPENSE','INDIRECT EXPENSE') " +
          "ORDER BY name,code LIMIT 3000",
        [companyId]
      );
      res.json({ accounts: result.rows });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get(prefix + "/automation/failures", requireAuth, async (req, res) => {
    try {
      const { companyId } = await identity(req, false);
      const result = await pool.query(
        'SELECT id,source_kind AS "sourceKind",source_id AS "sourceId",' +
          'left(last_error,200) AS "message",failure_count AS "failureCount",' +
          'last_seen AS "lastSeen" FROM cost_center_auto_failures ' +
          "WHERE company_id=$1 ORDER BY last_seen DESC LIMIT 30",
        [companyId]
      );
      res.json({ failures: result.rows });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get(prefix + "/automation/rules", requireAuth, async (req, res) => {
    try {
      const { companyId } = await identity(req, false);
      const result = await pool.query(
        [
          'SELECT r.id,r.source_kind AS "sourceKind",r.ledger_account_id AS "ledgerAccountId",',
          'r.source_module AS "sourceModule",r.factory_tx_type AS "factoryTxType",',
          'r.cost_center_id AS "costCenterId",c.code AS "costCenterCode",',
          'c.name AS "costCenterName",l.code AS "ledgerAccountCode",l.name AS "ledgerAccountName",',
          'r.allocation_percent::text AS "percent",r.active,r.created_at AS "createdAt"',
          "FROM cost_center_auto_rules r",
          "JOIN cost_centers c ON c.id=r.cost_center_id AND c.company_id=r.company_id",
          "LEFT JOIN ledger_accounts l ON l.id=r.ledger_account_id AND l.company_id=r.company_id",
          "WHERE r.company_id=$1 ORDER BY r.source_kind,l.name,r.factory_tx_type,r.source_module,r.id",
        ].join(" "),
        [companyId]
      );
      res.json({ rules: result.rows });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Replace one exact account/source combination atomically. A NULL module is
  // the fallback mapping; source-specific mappings override fallback mappings.
  // Does not re-tag existing transactions, even if the rule is edited.
  app.put(prefix + "/automation/rules", requireAuth, async (req, res) => {
    try {
      const actor = await identity(req, true);
      const value = parse(autoRuleSetBody, req.body);
      const isFactory = prefix === "/api/factory/cost-centers";
      if (value.sourceKind === "FACTORY_DAYBOOK" && !isFactory) {
        throw new ApiError(403, "Standalone Factory rules require Factory Mode");
      }
      const accountId = value.sourceKind === "VOUCHER_ENTRY" ? (value.ledgerAccountId ?? null) : null;
      const factoryType = value.sourceKind === "FACTORY_DAYBOOK" ? (value.factoryTxType ?? null) : null;
      const moduleName = value.sourceKind === "VOUCHER_ENTRY" ? (value.sourceModule ?? null) : null;
      if (
        (value.sourceKind === "VOUCHER_ENTRY" && (!accountId || value.factoryTxType != null)) ||
        (value.sourceKind === "FACTORY_DAYBOOK" &&
          (!factoryType || value.ledgerAccountId != null || value.sourceModule != null))
      ) {
        throw new ApiError(400, "Invalid source definition for automatic rule");
      }
      if (new Set(value.splits.map((s) => s.costCenterId)).size !== value.splits.length) {
        throw new ApiError(400, "Duplicate cost center in automatic split");
      }
      const percent = sumMoney(value.splits.map((s) => s.percent));
      if (percent.gt(100) || value.splits.some((s) => toMoney(s.percent).lte(0))) {
        throw new ApiError(400, "Split percentages must total at most 100%");
      }
      const updated = await transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(721032,$1)", [actor.companyId]);
        if (accountId !== null) {
          const account = await client.query(
            "SELECT id FROM ledger_accounts WHERE id=$1 AND company_id=$2 AND active=true AND deleted_at IS NULL " +
              "AND upper(btrim(account_type)) IN ('EXPENSE','DIRECT EXPENSE','INDIRECT EXPENSE') FOR SHARE",
            [accountId, actor.companyId]
          );
          if (!account.rows.length)
            throw new ApiError(409, "Select an active expense ledger account in the same company");
        }
        if (value.splits.length) {
          const centers = await client.query(
            "SELECT id FROM cost_centers WHERE company_id=$1 AND id=ANY($2::int[]) AND active=true FOR SHARE",
            [actor.companyId, value.splits.map((s) => s.costCenterId)]
          );
          if (centers.rows.length !== value.splits.length) {
            throw new ApiError(409, "One or more cost centers are archived or belong to another company");
          }
        }
        const where =
          "company_id=$1 AND source_kind=$2 AND ledger_account_id IS NOT DISTINCT FROM $3::integer " +
          "AND source_module IS NOT DISTINCT FROM $4::varchar " +
          "AND factory_tx_type IS NOT DISTINCT FROM $5::varchar";
        const params = [actor.companyId, value.sourceKind, accountId, moduleName, factoryType];
        const before = await client.query("SELECT * FROM cost_center_auto_rules WHERE " + where, params);
        await client.query("DELETE FROM cost_center_auto_rules WHERE " + where, params);
        for (const split of value.splits) {
          await client.query(
            "INSERT INTO cost_center_auto_rules(company_id,source_kind,ledger_account_id,source_module," +
              "factory_tx_type,cost_center_id,allocation_percent,created_by,updated_by) " +
              "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)",
            [
              actor.companyId,
              value.sourceKind,
              accountId,
              moduleName,
              factoryType,
              split.costCenterId,
              toMoney(split.percent).toFixed(4),
              actor.userId,
            ]
          );
        }
        const after = await client.query("SELECT * FROM cost_center_auto_rules WHERE " + where, params);
        await audit(
          client,
          actor,
          before.rows.length ? "update" : "create",
          "cost_center_auto_rules",
          null,
          value.sourceKind + ":" + (accountId ?? factoryType) + ":" + (moduleName ?? "*"),
          { rules: before.rows, reason: value.reason },
          { rules: after.rows, reason: value.reason }
        );
        return after.rows.length;
      });
      res.json({ saved: updated, scope: "future_entries_only" });
    } catch (error) {
      sendError(res, error);
    }
  });
  app.get(prefix + "/voucher/:voucherId/entries", requireAuth, async (req, res) => {
    try {
      const { companyId } = await identity(req, false);
      const voucherId = queryId(req.params.voucherId);
      const result = await pool.query(
        [
          'SELECT ve.id AS "entryId", la.name AS "accountName", la.code AS "accountCode",',
          'la.account_type AS "accountType",',
          "CASE WHEN upper(btrim(la.account_type)) = 'ASSET' THEN 'INVENTORY_COST' ELSE 'EXPENSE' END AS \"costTreatment\",",
          "COALESCE(ve.transaction_currency,v.currency,'USD') AS currency,",
          "GREATEST(abs(coalesce(ve.transaction_debit_amount,ve.debit_amount,0)),",
          'abs(coalesce(ve.transaction_credit_amount,ve.credit_amount,0)))::text AS "amountNative",',
          "GREATEST(abs(coalesce(ve.base_debit_amount,ve.debit_amount,0)),",
          'abs(coalesce(ve.base_credit_amount,ve.credit_amount,0)))::text AS "amountBase",',
          'COALESCE(sum(a.amount_native),0)::text AS "allocatedNative",',
          'COALESCE(sum(a.amount_base),0)::text AS "allocatedBase",',
          'count(a.id)::int AS "allocationCount"',
          "FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id=v.id AND ve.company_id=v.company_id",
          "JOIN ledger_accounts la ON la.id=ve.ledger_account_id AND la.company_id=v.company_id",
          "LEFT JOIN cost_center_allocations a ON a.voucher_entry_id=ve.id AND a.company_id=v.company_id",
          "WHERE v.id=$1 AND v.company_id=$2 AND v.deleted_at IS NULL AND v.optional=false",
          "AND v.voucher_number NOT LIKE 'GC-%' AND v.voucher_number NOT LIKE 'MIG-%'",
          "AND COALESCE(v.source_module,'') <> 'SP_MIGRATION_READONLY'",
          "AND upper(COALESCE(v.source_module,'')) NOT LIKE 'INTERCOMPANY%'",
          "AND NOT " + reversalPairSql("v"),
          "AND (upper(btrim(la.account_type)) IN ('EXPENSE','DIRECT EXPENSE','INDIRECT EXPENSE')",
          "OR ($3::boolean AND upper(btrim(la.account_type))='ASSET'",
          "AND la.code IN ('FACTORY_RAW_MATERIAL_STOCK','FACTORY_WIP','FACTORY_FINISHED_GOODS')",
          "AND ve.debit_amount > 0 AND ve.credit_amount = 0))",
          "GROUP BY ve.id,v.currency,la.id HAVING",
          "GREATEST(abs(coalesce(ve.base_debit_amount,ve.debit_amount,0)),",
          "abs(coalesce(ve.base_credit_amount,ve.credit_amount,0))) > 0",
          "ORDER BY ve.id",
        ].join(" "),
        [voucherId, companyId, prefix === "/api/factory/cost-centers"]
      );
      res.json({ entries: result.rows });
    } catch (error) {
      sendError(res, error);
    }
  });
  app.get(prefix + "/allocations/:sourceType/:sourceId", requireAuth, async (req, res) => {
    try {
      const { companyId } = await identity(req, false);
      const kind = parse(sourceKinds, req.params.sourceType);
      assertPrefixScope(prefix, kind);
      const id = queryId(req.params.sourceId);
      const value = await transaction(async (client) => {
        const source = await sourceInCompany(client, companyId, kind, id);
        sourceTreatment(source, kind);
        const splits = await splitList(client, companyId, kind, id);
        const allocatedNative = sumMoney(splits.map((x) => x.amountNative)).toFixed(6);
        const allocatedBase = sumMoney(splits.map((x) => x.amountBase)).toFixed(6);
        return {
          sourceType: kind,
          sourceId: id,
          currency: source.currency,
          totalNative: source.amountNative,
          totalBase: source.amountBase,
          allocatedNative,
          allocatedBase,
          unallocatedNative: toMoney(source.amountNative).minus(allocatedNative).toFixed(6),
          unallocatedBase: toMoney(source.amountBase).minus(allocatedBase).toFixed(6),
          splits,
        };
      });
      res.json(value);
    } catch (e) {
      sendError(res, e);
    }
  });
}
