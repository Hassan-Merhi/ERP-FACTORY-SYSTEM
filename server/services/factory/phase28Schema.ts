/**
 * Accounting audit phases 28/29 tables, ensured on every boot through
 * ensureFactoryCostBasisSchema (production runs with
 * RUN_STARTUP_MIGRATIONS=false). Same columns and index names as
 * shared/schema/factory/phase28-accounting.ts. Idempotent (IF NOT EXISTS), no
 * foreign keys, no table rewrite.
 */
export const PHASE28_ACCOUNTING_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS factory_ar_cutovers (
     company_id integer PRIMARY KEY,
     effective_from date NOT NULL,
     opening_voucher_ids jsonb NOT NULL,
     plan_hash text NOT NULL,
     opening_plan jsonb NOT NULL,
     applied_by text,
     applied_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS factory_bale_cost_resolutions (
     id serial PRIMARY KEY,
     company_id integer NOT NULL,
     bale_id integer NOT NULL,
     action text NOT NULL,
     mix_batch_id integer,
     old_total_cost numeric(20,7) NOT NULL,
     new_total_cost numeric(20,7) NOT NULL,
     reason text,
     plan_hash text NOT NULL,
     applied_by text,
     applied_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS factory_bale_cost_resolutions_company_bale_idx
     ON factory_bale_cost_resolutions (company_id, bale_id)`,
  `CREATE TABLE IF NOT EXISTS factory_stock_valuation_snapshots (
     company_id integer NOT NULL,
     valuation_date date NOT NULL,
     raw numeric(20,2) NOT NULL,
     wip numeric(20,2) NOT NULL,
     finished numeric(20,2) NOT NULL,
     unvalued integer NOT NULL DEFAULT 0,
     voucher_id integer,
     basis text NOT NULL,
     recorded_at timestamp NOT NULL DEFAULT now(),
     CONSTRAINT factory_stock_valuation_snapshots_company_id_valuation_date_pk PRIMARY KEY (company_id, valuation_date)
   )`,
  `CREATE TABLE IF NOT EXISTS factory_invoice_mirror_reductions (
     id serial PRIMARY KEY,
     company_id integer NOT NULL,
     order_id integer NOT NULL,
     bale_id integer NOT NULL,
     stock_item_id integer NOT NULL,
     location_id integer NOT NULL,
     quantity numeric(18,3) NOT NULL,
     value numeric(20,2) NOT NULL,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS factory_invoice_mirror_reductions_order_bale_unique
     ON factory_invoice_mirror_reductions (order_id, bale_id)`,
  `CREATE TABLE IF NOT EXISTS retail_supplier_invoices (
     id serial PRIMARY KEY,
     company_id integer NOT NULL,
     supplier_id integer NOT NULL,
     invoice_number text NOT NULL,
     invoice_date date NOT NULL,
     amount numeric(20,2) NOT NULL,
     grni_cleared numeric(20,2) NOT NULL,
     variance numeric(20,2) NOT NULL,
     voucher_id integer,
     created_by text,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS retail_supplier_invoices_company_supplier_number_unique
     ON retail_supplier_invoices (company_id, supplier_id, invoice_number)`,
  `CREATE TABLE IF NOT EXISTS retail_supplier_invoice_receipts (
     id serial PRIMARY KEY,
     company_id integer NOT NULL,
     invoice_id integer NOT NULL,
     receipt_voucher_id integer NOT NULL,
     amount numeric(20,2) NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS retail_supplier_invoice_receipts_receipt_unique
     ON retail_supplier_invoice_receipts (receipt_voucher_id)`,
];
