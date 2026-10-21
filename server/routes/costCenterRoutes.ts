/**
 * Cost-center Phase 2 API. Shared by ERP and Factory through two route prefixes.
 * These are analytical tags only; no financial journal or balance is posted.
 */
import type { Express, Request, Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { requireAuth } from "../auth";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";
import { toMoney, sumMoney } from "../lib/money";
import { reversalPairSql, sourceCte } from "./costCenterReportingRoutes";

const EDIT_ROLES = new Set(["Admin", "Owner", "Developer"]);
const READ_ROLES = new Set(["Admin", "Owner", "Developer", "Manager"]);
const maxId = z.coerce.number().int().positive().max(2147483647);
const centerBody = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    name: z.string().trim().min(1).max(180),
    description: z.string().trim().max(2000).nullable().optional(),
    parentId: maxId.nullable().optional(),
  })
  .strict();
const editBody = centerBody.partial().extend({ active: z.boolean().optional() }).strict();
const amount = z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/);
const split = z
  .object({
    costCenterId: maxId,
    amountNative: amount,
    amountBase: amount,
    costTreatment: z.enum(["EXPENSE", "INVENTORY_COST", "OTHER"]),
  })
  .strict();
const replaceBody = z
  .object({
    splits: z.array(split).max(100),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
const sourceKinds = z.enum(["voucher_entry", "factory_daybook"]);
const autoSourceKinds = z.enum(["VOUCHER_ENTRY", "FACTORY_DAYBOOK"]);
const autoRuleSetBody = z
  .object({
    sourceKind: autoSourceKinds,
    ledgerAccountId: maxId.nullable().optional(),
    sourceModule: z.enum(["ERP", "FACTORY"]).nullable().optional(),
    factoryTxType: z.enum(["EXPENSE", "OPERATING_EXPENSE", "FACTORY_EXPENSE"]).nullable().optional(),
    splits: z
      .array(
        z
          .object({
            costCenterId: maxId,
            percent: z.string().regex(/^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/),
          })
          .strict()
      )
      .max(30),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
type SourceKind = z.infer<typeof sourceKinds>;

class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}
function queryId(value: unknown): number {
  return parse(maxId, value);
}
function pageQuery(value: unknown, defaultValue: number, limit: number): number {
  if (value === undefined) return defaultValue;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > limit) throw new ApiError(400, "Invalid pagination");
  return n;
}
async function identity(req: Request, write: boolean) {
  const context = await getActiveCompanyPermissionContext(req);
  if (!(write ? EDIT_ROLES : READ_ROLES).has(context.role)) {
    throw new ApiError(403, "Accounting cost center permission required");
  }
  return {
    companyId: context.companyId,
    userId: context.userId,
    username: String(req.session.username || context.userId),
  };
}
function sendError(res: Response, error: unknown) {
  if (error instanceof ApiError) return res.status(error.status).json({ message: error.message });
  if (error instanceof ActiveCompanyPermissionContextError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  if (error && typeof error === "object") {
    const code = String((error as { code?: string }).code || "");
    if (code === "42P01") {
      return res
        .status(503)
        .json({ message: "Cost centers are not installed yet", code: "COST_CENTERS_NOT_INSTALLED" });
    }
    if (code === "22007" || code === "22008") return res.status(400).json({ message: "Invalid date" });
    if (code === "23505") return res.status(409).json({ message: "Cost center or allocation already exists" });
    if (code === "23503" || code === "23514" || code === "P0001") {
      return res.status(409).json({ message: "Cost center hierarchy or source allocation is invalid" });
    }
  }
  logger.error("Cost center allocation request failed", { module: "cost-centers", error });
  return res.status(500).json({ message: "Cost center operation failed" });
}
async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
type Actor = Awaited<ReturnType<typeof identity>>;
async function audit(
  client: PoolClient,
  actor: Actor,
  action: "create" | "update" | "delete",
  tableName: string,
  recordId: number | null,
  reference: string,
  before: unknown,
  after: unknown
) {
  await client.query(
    "INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_id, record_identifier, changes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [
      actor.userId,
      actor.username,
      actor.companyId,
      action,
      tableName,
      recordId,
      reference,
      JSON.stringify({ snapshot: { old: before, new: after } }),
    ]
  );
}
const fields =
  'id, company_id AS "companyId", code, name, description, parent_id AS "parentId", active, created_by AS "createdBy", updated_by AS "updatedBy", created_at AS "createdAt", updated_at AS "updatedAt"';
async function centerInCompany(client: PoolClient, companyId: number, id: number, lock = false) {
  const result = await client.query(
    "SELECT " + fields + " FROM cost_centers WHERE company_id=$1 AND id=$2" + (lock ? " FOR UPDATE" : ""),
    [companyId, id]
  );
  if (!result.rows.length) throw new ApiError(404, "Cost center not found");
  return result.rows[0] as Record<string, unknown>;
}
/** Standalone Factory daybook expenses and factory inventory costs exist only in Factory Mode. */
function assertPrefixScope(prefix: string, kind: SourceKind, treatments: readonly string[] = []) {
  if (prefix === "/api/factory/cost-centers") return;
  if (kind === "factory_daybook")
    throw new ApiError(403, "Factory Daybook allocations are available only in Factory Mode");
  if (treatments.includes("INVENTORY_COST"))
    throw new ApiError(403, "Factory inventory cost allocations are available only in Factory Mode");
}
function sourceColumn(kind: SourceKind) {
  return kind === "voucher_entry" ? "voucher_entry_id" : "factory_daybook_entry_id";
}
async function sourceInCompany(client: PoolClient, companyId: number, kind: SourceKind, sourceId: number) {
  if (kind === "voucher_entry") {
    const source = await client.query(
      [
        'SELECT ve.id, ve.company_id AS "companyId",',
        "COALESCE(ve.transaction_currency,v.currency,'USD') AS currency,",
        'GREATEST(abs(coalesce(ve.transaction_debit_amount,ve.debit_amount,0)),abs(coalesce(ve.transaction_credit_amount,ve.credit_amount,0)))::text AS "amountNative",',
        'GREATEST(abs(coalesce(ve.base_debit_amount,ve.debit_amount,0)),abs(coalesce(ve.base_credit_amount,ve.credit_amount,0)))::text AS "amountBase",',
        've.historical_exchange_rate::text AS "historicalRate", ve.rate_convention AS "rateConvention",',
        'la.account_type AS "accountType", la.code AS "accountCode",',
        've.debit_amount::text AS "debitAmount", ve.credit_amount::text AS "creditAmount",',
        'v.voucher_number AS "voucherNumber",',
        'v.source_module AS "sourceModule", v.optional,',
        reversalPairSql("v") + ' AS "inReversalPair"',
        "FROM voucher_entries ve JOIN vouchers v ON v.id=ve.voucher_id",
        "LEFT JOIN ledger_accounts la ON la.id=ve.ledger_account_id AND la.company_id=ve.company_id",
        "WHERE ve.id=$1 AND ve.company_id=$2 AND v.company_id=$2 AND v.deleted_at IS NULL",
        "FOR SHARE OF ve, v",
      ].join(" "),
      [sourceId, companyId]
    );
    if (!source.rows.length) throw new ApiError(404, "Active voucher entry not found");
    const row = source.rows[0];
    if (
      row.optional ||
      String(row.voucherNumber).startsWith("GC-") ||
      String(row.voucherNumber).startsWith("MIG-") ||
      row.sourceModule === "SP_MIGRATION_READONLY" ||
      String(row.sourceModule || "")
        .toUpperCase()
        .startsWith("INTERCOMPANY") ||
      row.inReversalPair
    ) {
      throw new ApiError(409, "Protected, migrated, or optional vouchers cannot be reallocated");
    }
    if (!row.accountType) throw new ApiError(409, "Only ledger account expense or inventory lines can be allocated");
    return row;
  }
  // Only standalone expense events. JOURNAL, PAYMENT, POS_EXPENSE and similar
  // factory daybook entries are already mirrored into voucher accounting.
  const source = await client.query(
    [
      'SELECT id, company_id AS "companyId", currency_code AS currency,',
      'abs(amount_currency)::text AS "amountNative", abs(amount_usd)::text AS "amountBase",',
      'fx_rate_to_usd::text AS "historicalRate", tx_type AS "txType",',
      'reference_table AS "referenceTable", reference_id AS "referenceId"',
      "FROM factory_daybook_entries",
      "WHERE id=$1 AND company_id=$2 AND tx_type IN ('EXPENSE','OPERATING_EXPENSE','FACTORY_EXPENSE')",
      "AND reference_id IS NULL AND NULLIF(btrim(COALESCE(reference_table,'')),'') IS NULL",
      "AND amount_currency>0 AND amount_usd>=0",
      "FOR SHARE",
    ].join(" "),
    [sourceId, companyId]
  );
  if (!source.rows.length)
    throw new ApiError(409, "Only truly standalone, unreferenced factory expense daybook entries can be allocated");
  return source.rows[0];
}
function sourceTreatment(row: Record<string, unknown>, kind: SourceKind): "EXPENSE" | "INVENTORY_COST" {
  if (kind === "factory_daybook") return "EXPENSE";
  const accountType = String(row.accountType || "")
    .trim()
    .toUpperCase();
  if (["EXPENSE", "INDIRECT EXPENSE", "DIRECT EXPENSE"].includes(accountType)) return "EXPENSE";
  if (
    accountType === "ASSET" &&
    ["FACTORY_RAW_MATERIAL_STOCK", "FACTORY_WIP", "FACTORY_FINISHED_GOODS"].includes(String(row.accountCode)) &&
    toMoney(row.debitAmount as string).gt(0) &&
    toMoney(row.creditAmount as string).eq(0)
  )
    return "INVENTORY_COST";
  throw new ApiError(409, "Source line is not an expense or eligible inventory asset");
}
async function splitList(client: PoolClient, companyId: number, kind: SourceKind, sourceId: number) {
  const column = sourceColumn(kind);
  const result = await client.query(
    'SELECT a.id, a.cost_center_id AS "costCenterId",c.code AS "costCenterCode",' +
      'c.name AS "costCenterName",a.amount_native::text AS "amountNative",a.amount_base::text AS "amountBase",' +
      'a.currency,a.base_currency AS "baseCurrency",a.historical_rate::text AS "historicalRate",' +
      'a.rate_convention AS "rateConvention",a.cost_treatment AS "costTreatment",a.created_by AS "createdBy",' +
      'a.allocation_origin AS "allocationOrigin",a.auto_rule_id AS "autoRuleId",' +
      'a.updated_by AS "updatedBy",a.created_at AS "createdAt",a.updated_at AS "updatedAt"' +
      " FROM cost_center_allocations a JOIN cost_centers c ON c.id=a.cost_center_id AND c.company_id=a.company_id" +
      " WHERE a.company_id=$1 AND a." +
      column +
      "=$2 ORDER BY c.code",
    [companyId, sourceId]
  );
  return result.rows;
}

function registerCostCenterPrefix(app: Express, prefix: string) {
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

export function registerCostCenterRoutes(app: Express): void {
  registerCostCenterPrefix(app, "/api/cost-centers");
  registerCostCenterPrefix(app, "/api/factory/cost-centers");
}
