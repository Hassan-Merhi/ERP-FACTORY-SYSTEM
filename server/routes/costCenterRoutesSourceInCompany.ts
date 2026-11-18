// Extracted from ./costCenterRoutes.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../db";
import { logger } from "../lib/logger";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";
import { toMoney } from "../lib/money";
import { reversalPairSql } from "./costCenterReportingRoutes";

const EDIT_ROLES = new Set(["Admin", "Owner", "Developer"]);

const READ_ROLES = new Set(["Admin", "Owner", "Developer", "Manager"]);

const maxId = z.coerce.number().int().positive().max(2147483647);

export const centerBody = z
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

export const editBody = centerBody.partial().extend({ active: z.boolean().optional() }).strict();

const amount = z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/);

const split = z
  .object({
    costCenterId: maxId,
    amountNative: amount,
    amountBase: amount,
    costTreatment: z.enum(["EXPENSE", "INVENTORY_COST", "OTHER"]),
  })
  .strict();

export const replaceBody = z
  .object({
    splits: z.array(split).max(100),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const sourceKinds = z.enum(["voucher_entry", "factory_daybook"]);

const autoSourceKinds = z.enum(["VOUCHER_ENTRY", "FACTORY_DAYBOOK"]);

export const autoRuleSetBody = z
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

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

export function queryId(value: unknown): number {
  return parse(maxId, value);
}

export function pageQuery(value: unknown, defaultValue: number, limit: number): number {
  if (value === undefined) return defaultValue;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > limit) throw new ApiError(400, "Invalid pagination");
  return n;
}

export async function identity(req: Request, write: boolean) {
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

export function sendError(res: Response, error: unknown) {
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

export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
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

export async function audit(
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

export const fields =
  'id, company_id AS "companyId", code, name, description, parent_id AS "parentId", active, created_by AS "createdBy", updated_by AS "updatedBy", created_at AS "createdAt", updated_at AS "updatedAt"';

export async function centerInCompany(client: PoolClient, companyId: number, id: number, lock = false) {
  const result = await client.query(
    "SELECT " + fields + " FROM cost_centers WHERE company_id=$1 AND id=$2" + (lock ? " FOR UPDATE" : ""),
    [companyId, id]
  );
  if (!result.rows.length) throw new ApiError(404, "Cost center not found");
  return result.rows[0] as Record<string, unknown>;
}

/** Standalone Factory daybook expenses and factory inventory costs exist only in Factory Mode. */
export function assertPrefixScope(prefix: string, kind: SourceKind, treatments: readonly string[] = []) {
  if (prefix === "/api/factory/cost-centers") return;
  if (kind === "factory_daybook")
    throw new ApiError(403, "Factory Daybook allocations are available only in Factory Mode");
  if (treatments.includes("INVENTORY_COST"))
    throw new ApiError(403, "Factory inventory cost allocations are available only in Factory Mode");
}

export function sourceColumn(kind: SourceKind) {
  return kind === "voucher_entry" ? "voucher_entry_id" : "factory_daybook_entry_id";
}

export async function sourceInCompany(client: PoolClient, companyId: number, kind: SourceKind, sourceId: number) {
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

export function sourceTreatment(row: Record<string, unknown>, kind: SourceKind): "EXPENSE" | "INVENTORY_COST" {
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

export async function splitList(client: PoolClient, companyId: number, kind: SourceKind, sourceId: number) {
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
