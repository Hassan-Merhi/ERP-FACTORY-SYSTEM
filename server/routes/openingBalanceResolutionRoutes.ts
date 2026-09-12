import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { pool } from "../db";
import { requireAuth, requireNonPOS } from "../auth";
import { normalizeOpeningBalanceCurrency } from "../services/accounting/openingBalanceCurrency";

const ALLOWED_ROLES = new Set(["Admin", "Owner", "Developer"]);

type EntityType = "ledger" | "bank" | "customer" | "supplier" | "employee" | "fixedAsset";

interface EntityConfig {
  table: string;
  amountColumn: string;
  nativeColumn: string;
  currencyColumn: string;
  rateColumn: string;
  baseColumn: string;
  sideColumn?: string;
  companyColumn?: string;
  deletedColumn?: string;
}

const CONFIG: Record<EntityType, EntityConfig> = {
  ledger: {
    table: "ledger_accounts",
    amountColumn: "opening_balance",
    nativeColumn: "opening_balance_native_amount",
    currencyColumn: "opening_balance_currency",
    rateColumn: "opening_balance_historical_rate",
    baseColumn: "opening_balance_base_amount",
    sideColumn: "opening_balance_side",
    companyColumn: "company_id",
    deletedColumn: "deleted_at",
  },
  bank: {
    table: "bank_accounts",
    amountColumn: "opening_balance",
    nativeColumn: "opening_balance_native_amount",
    currencyColumn: "opening_balance_currency",
    rateColumn: "opening_balance_historical_rate",
    baseColumn: "opening_balance_base_amount",
    sideColumn: "opening_balance_side",
    companyColumn: "company_id",
    deletedColumn: "deleted_at",
  },
  customer: {
    table: "customers",
    amountColumn: "opening_balance",
    nativeColumn: "opening_balance_native_amount",
    currencyColumn: "opening_balance_currency",
    rateColumn: "opening_balance_historical_rate",
    baseColumn: "opening_balance_base_amount",
    sideColumn: "opening_balance_side",
    companyColumn: "company_id",
    deletedColumn: "deleted_at",
  },
  supplier: {
    table: "suppliers",
    amountColumn: "opening_balance",
    nativeColumn: "opening_balance_native_amount",
    currencyColumn: "opening_balance_currency",
    rateColumn: "opening_balance_historical_rate",
    baseColumn: "opening_balance_base_amount",
    sideColumn: "opening_balance_side",
    deletedColumn: "deleted_at",
  },
  employee: {
    table: "employees",
    amountColumn: "opening_balance",
    nativeColumn: "opening_balance_native_amount",
    currencyColumn: "opening_balance_currency",
    rateColumn: "opening_balance_historical_rate",
    baseColumn: "opening_balance_base_amount",
    sideColumn: "opening_balance_side",
    companyColumn: "company_id",
    deletedColumn: "deleted_at",
  },
  fixedAsset: {
    table: "fixed_assets",
    amountColumn: "purchase_amount",
    nativeColumn: "purchase_native_amount",
    currencyColumn: "purchase_currency",
    rateColumn: "purchase_historical_rate",
    baseColumn: "purchase_base_amount",
    companyColumn: "company_id",
  },
};

async function getBaseCurrency(companyId: number): Promise<string> {
  const result = await pool.query<{ base_currency: string | null }>(
    "SELECT base_currency FROM companies WHERE id = $1",
    [companyId],
  );
  return result.rows[0]?.base_currency || "USD";
}

function supplierScopeSql(alias = "target"): string {
  return `EXISTS (
    SELECT 1
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
     WHERE ve.supplier_id = ${alias}.id
       AND v.company_id = $2
       AND v.deleted_at IS NULL
  )`;
}

async function entityExists(entityType: EntityType, entityId: number, companyId: number): Promise<boolean> {
  const config = CONFIG[entityType];
  const clauses = ["target.id = $1"];
  if (config.companyColumn) clauses.push(`target.${config.companyColumn} = $2`);
  else clauses.push(supplierScopeSql("target"));
  if (config.deletedColumn) clauses.push(`target.${config.deletedColumn} IS NULL`);
  const result = await pool.query(
    `SELECT 1 FROM ${config.table} target WHERE ${clauses.join(" AND ")} LIMIT 1`,
    [entityId, companyId],
  );
  return result.rowCount === 1;
}

export function registerOpeningBalanceResolutionRoutes(app: Express) {
  app.get(
    "/api/accounts/multi-currency/unresolved-openings",
    requireAuth,
    requireNonPOS,
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const result = await pool.query(
          `SELECT * FROM (
             SELECT 'ledger'::text AS entity_type, la.id, la.name, la.code,
                    la.opening_balance::text AS raw_amount,
                    COALESCE(la.opening_balance_side, 'Dr') AS side
               FROM ledger_accounts la
              WHERE la.company_id = $1 AND la.deleted_at IS NULL
                AND COALESCE(la.opening_balance, 0)::numeric <> 0
                AND (la.opening_balance_native_amount IS NULL OR la.opening_balance_currency IS NULL OR la.opening_balance_base_amount IS NULL)
             UNION ALL
             SELECT 'bank', ba.id, ba.name, ba.code, ba.opening_balance::text,
                    COALESCE(ba.opening_balance_side, 'Dr')
               FROM bank_accounts ba
              WHERE ba.company_id = $1 AND ba.deleted_at IS NULL
                AND COALESCE(ba.opening_balance, 0)::numeric <> 0
                AND (ba.opening_balance_native_amount IS NULL OR ba.opening_balance_currency IS NULL OR ba.opening_balance_base_amount IS NULL)
             UNION ALL
             SELECT 'customer', c.id, c.legal_name, c.code, c.opening_balance::text,
                    COALESCE(c.opening_balance_side, 'Dr')
               FROM customers c
              WHERE c.company_id = $1 AND c.deleted_at IS NULL
                AND COALESCE(c.opening_balance, 0)::numeric <> 0
                AND (c.opening_balance_native_amount IS NULL OR c.opening_balance_currency IS NULL OR c.opening_balance_base_amount IS NULL)
             UNION ALL
             SELECT 'supplier', s.id, s.legal_name, s.code, s.opening_balance::text,
                    COALESCE(s.opening_balance_side, 'Cr')
               FROM suppliers s
              WHERE s.deleted_at IS NULL
                AND COALESCE(s.opening_balance, 0)::numeric <> 0
                AND (s.opening_balance_native_amount IS NULL OR s.opening_balance_currency IS NULL OR s.opening_balance_base_amount IS NULL)
                AND ${supplierScopeSql("s")}
             UNION ALL
             SELECT 'employee', e.id, CONCAT_WS(' ', e.first_name, e.last_name), e.code,
                    e.opening_balance::text, COALESCE(e.opening_balance_side, 'Cr')
               FROM employees e
              WHERE e.company_id = $1 AND e.deleted_at IS NULL
                AND COALESCE(e.opening_balance, 0)::numeric <> 0
                AND (e.opening_balance_native_amount IS NULL OR e.opening_balance_currency IS NULL OR e.opening_balance_base_amount IS NULL)
             UNION ALL
             SELECT 'fixedAsset', fa.id, fa.name, fa.code, fa.purchase_amount::text, 'Dr'
               FROM fixed_assets fa
              WHERE fa.company_id = $1
                AND COALESCE(fa.purchase_amount, 0)::numeric <> 0
                AND (fa.purchase_native_amount IS NULL OR fa.purchase_currency IS NULL OR fa.purchase_base_amount IS NULL)
           ) unresolved
           ORDER BY entity_type, name`,
          [companyId, companyId],
        );
        return res.json(result.rows);
      } catch (error: unknown) {
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    },
  );

  app.put(
    "/api/accounts/multi-currency/opening-balance/:entityType/:id",
    requireAuth,
    requireNonPOS,
    async (req, res) => {
      const role = req.session.currentRole;
      if (!role || !ALLOWED_ROLES.has(role)) {
        return res.status(403).json({ message: "Admin, Owner, or Developer access is required" });
      }

      const entityType = req.params.entityType as EntityType;
      const config = CONFIG[entityType];
      if (!config) return res.status(400).json({ message: "Unsupported entity type" });
      const entityId = Number.parseInt(req.params.id, 10);
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!Number.isInteger(entityId) || entityId <= 0) {
        return res.status(400).json({ message: "Invalid entity ID" });
      }

      try {
        if (!(await entityExists(entityType, entityId, companyId))) {
          return res.status(404).json({ message: "Entity not found in current company" });
        }

        const baseCurrency = await getBaseCurrency(companyId);
        const normalized = normalizeOpeningBalanceCurrency({
          openingBalance: req.body.nativeAmount,
          openingBalanceCurrency: req.body.currency,
          openingBalanceHistoricalRate: req.body.historicalRate,
          openingBalanceBaseAmount: req.body.baseAmount,
          baseCurrency,
        });
        // Supplier and employee opening balances retain their established credit
        // orientation; ledger/bank/customer sides may be explicitly reviewed.
        const side =
          entityType === "supplier" || entityType === "employee"
            ? "Cr"
            : req.body.side || "Dr";
        if (side !== "Dr" && side !== "Cr") {
          return res.status(400).json({ message: "Side must be Dr or Cr" });
        }

        const assignments = [
          `${config.amountColumn} = $1`,
          `${config.nativeColumn} = $2`,
          `${config.currencyColumn} = $3`,
          `${config.rateColumn} = $4`,
          `${config.baseColumn} = $5`,
        ];
        const values: Array<string | number | null> = [
          normalized.openingBalanceBaseAmount,
          normalized.openingBalanceNativeAmount,
          normalized.openingBalanceCurrency,
          normalized.openingBalanceHistoricalRate,
          normalized.openingBalanceBaseAmount,
        ];
        if (config.sideColumn) {
          assignments.push(`${config.sideColumn} = $6`);
          values.push(side);
        }

        const whereIndex = values.length + 1;
        values.push(entityId);
        const result = await pool.query(
          `UPDATE ${config.table}
              SET ${assignments.join(", ")}
            WHERE id = $${whereIndex}
            RETURNING id,
                      ${config.amountColumn} AS historical_base_amount,
                      ${config.nativeColumn} AS native_amount,
                      ${config.currencyColumn} AS currency,
                      ${config.rateColumn} AS historical_rate,
                      ${config.baseColumn} AS base_amount${config.sideColumn ? `, ${config.sideColumn} AS side` : ""}`,
          values,
        );

        return res.json({ entityType, ...result.rows[0] });
      } catch (error: unknown) {
        return res.status(400).json({ message: getErrorMessage(error) });
      }
    },
  );
}
