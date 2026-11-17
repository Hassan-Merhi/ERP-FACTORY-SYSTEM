import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const migrations = [
  "20261105_001_intercompany_phase1_foundation.sql",
  "20261105_002_intercompany_phase2_import.sql",
  "20261105_003_intercompany_phase3_sync.sql",
  "20261105_004_intercompany_phase4_payments.sql",
  "20261105_005_intercompany_phase5_lifecycle.sql",
  "20261113_001_intercompany_pristine_physical_delete.sql",
].map((name) => readFileSync(join(process.cwd(), "migrations", name), "utf8"));

describe("pristine linked PO deletion in both companies", () => {
  it("physically removes original source and destination POs/vouchers without reversal, preserving unrelated records", async () => {
    if (!process.env.DATABASE_URL) return;
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    });
    await client.connect();
    await client.query("BEGIN");
    try {
      const schema = "ic_delete_probe_" + process.pid;
      await client.query("CREATE SCHEMA " + schema);
      await client.query("SET LOCAL search_path TO " + schema);
      await client.query(
        "CREATE TABLE companies(id integer PRIMARY KEY,name text);" +
          "CREATE TABLE users(id varchar PRIMARY KEY);" +
          "CREATE TABLE user_company_roles(user_id varchar,company_id integer,role text);" +
          "CREATE TABLE ledger_accounts(id integer PRIMARY KEY,company_id integer,code text,account_type text,active boolean,deleted_at timestamp);" +
          "CREATE TABLE bank_accounts(id integer PRIMARY KEY,company_id integer,active boolean,deleted_at timestamp);" +
          "CREATE TABLE suppliers(id integer PRIMARY KEY,company_id integer,active boolean,deleted_at timestamp,legal_name text);" +
          "CREATE TABLE containers(id integer PRIMARY KEY,company_id integer,supplier_id integer,status text,container_number text,offload_date date,items_total numeric,charges_total numeric,grand_total numeric);" +
          "CREATE TABLE vouchers(id integer PRIMARY KEY,company_id integer,voucher_type text,total_amount numeric,deleted_at timestamp,description text,reversal_of_voucher_id integer);" +
          "CREATE TABLE purchase_orders(id integer PRIMARY KEY,company_id integer,container_id integer,voucher_id integer,po_number text,items_total numeric,freight numeric,surcharge numeric,fumigation numeric,document_charges numeric,discount numeric,other_charges numeric,charges_edited boolean,status text);" +
          "CREATE TABLE voucher_entries(id serial PRIMARY KEY,voucher_id integer REFERENCES vouchers(id) ON DELETE CASCADE,bank_account_id integer,ledger_account_id integer,supplier_id integer,debit_amount numeric,credit_amount numeric);" +
          "CREATE TABLE po_line_items(id integer PRIMARY KEY,po_id integer REFERENCES purchase_orders(id) ON DELETE CASCADE,stock_item_id integer,item_name text,quantity numeric,rate numeric,line_total numeric);" +
          "CREATE TABLE container_charges(id serial PRIMARY KEY,container_id integer,charge_type text,amount numeric,ledger_account_id integer);" +
          "CREATE TABLE container_offloads(id serial PRIMARY KEY,container_id integer);" +
          "CREATE TABLE locations(id integer PRIMARY KEY,company_id integer,deleted_at timestamp);" +
          "CREATE TABLE stock_items(id integer PRIMARY KEY,company_id integer);" +
          "CREATE TABLE canonical_stock_movements(id bigint PRIMARY KEY,company_id integer,stock_item_id integer,location_id integer,movement_kind text,source_type text,source_id text,quantity_delta numeric,unit_cost numeric);" +
          "CREATE TABLE accounting_posting_requests(id serial PRIMARY KEY,company_id integer,voucher_id integer REFERENCES vouchers(id) ON DELETE RESTRICT,source_type text);"
      );
      for (const migration of migrations) await client.query(migration);
      await client.query("INSERT INTO companies VALUES (1,'Parent'),(2,'TEST HADI')");
      await client.query("INSERT INTO users VALUES ('owner')");
      await client.query("INSERT INTO user_company_roles VALUES ('owner',1,'Owner'),('owner',2,'Owner')");
      await client.query(
        "INSERT INTO ledger_accounts(id,company_id,code,account_type,active) VALUES " +
          "(11,1,'AR','Asset',true),(12,1,'PURCHASES','Asset',true),(13,1,'SALES','Income',true)," +
          "(14,1,'COGS','Expense',true),(15,2,'AP','Liability',true),(16,2,'GIT','Asset',true),(17,1,'CHARGE','Liability',true)"
      );
      await client.query("INSERT INTO suppliers VALUES (1,1,true,NULL,'External Supplier'),(2,2,true,NULL,'Parent')");
      await client.query("INSERT INTO locations VALUES (301,2,NULL)");
      await client.query("INSERT INTO stock_items VALUES (501,2)");
      await client.query(
        "INSERT INTO containers VALUES (10,1,1,'OTW','MRSU4976363',NULL,50928.75,0,50928.75)," +
          "(11,1,1,'OTW','UNRELATED',NULL,10,0,10)"
      );
      await client.query(
        "INSERT INTO vouchers(id,company_id,voucher_type,total_amount,description) VALUES " +
          "(51,1,'Purchase',50928.75,'Original supplier')," +
          "(52,2,'Purchase',50928.75,'TEST HADI')," +
          "(53,1,'Sales',50928.75,'Intercompany sale')," +
          "(54,1,'Journal',50928.75,'Intercompany COGS')," +
          "(55,1,'Journal',10,'Unrelated')"
      );
      await client.query(
        "INSERT INTO voucher_entries(voucher_id,ledger_account_id,debit_amount,credit_amount) VALUES " +
          "(51,12,50928.75,0),(51,17,0,50928.75),(52,16,50928.75,0),(52,15,0,50928.75)," +
          "(53,11,50928.75,0),(53,13,0,50928.75),(54,14,50928.75,0),(54,12,0,50928.75)"
      );
      await client.query(
        "INSERT INTO purchase_orders(id,company_id,container_id,voucher_id,po_number,items_total,freight,surcharge,fumigation,document_charges,discount,other_charges,status) VALUES " +
          "(21,1,10,51,'EXT',50928.75,0,0,0,0,0,0,'Open'),(22,2,10,52,'IC',50928.75,0,0,0,0,0,0,'Open')"
      );
      await client.query(
        "INSERT INTO po_line_items(id,po_id,stock_item_id,item_name,quantity,rate,line_total) VALUES " +
          "(31,21,501,'Bales',1,50928.75,50928.75),(32,22,501,'Bales',1,50928.75,50928.75)"
      );
      await client.query(
        "INSERT INTO intercompany_relationship_policies(source_company_id,destination_company_id,relationship_type,trade_enabled,source_receivable_account_id,destination_payable_account_id,destination_supplier_id,source_purchase_account_id,source_sales_account_id,source_cost_account_id,source_charge_accrual_account_id,destination_git_account_id) VALUES " +
          "(1,2,'container_trade',true,11,15,2,12,13,14,17,16)"
      );
      await client.query(
        "INSERT INTO intercompany_trades(relationship_id,physical_container_id,source_company_id,destination_company_id,original_supplier_po_id,destination_po_id,state) VALUES (1,10,1,2,21,22,'active')"
      );
      await client.query(
        "INSERT INTO intercompany_trade_source_pos(trade_id,source_po_id,original_po_number) VALUES (1,21,'EXT')"
      );
      await client.query(
        "INSERT INTO intercompany_trade_line_links(trade_id,source_line_id,destination_line_id,original_excel_row) VALUES (1,31,32,1)"
      );
      await client.query(
        "INSERT INTO intercompany_import_batches(source_company_id,file_name,file_sha256,request_fingerprint,state,created_by) VALUES " +
          "(1,'test.xlsx',repeat('a',64),repeat('b',64),'confirmed','owner')"
      );
      await client.query(
        "INSERT INTO intercompany_import_batch_containers(batch_id,container_number,destination_company_id,physical_container_id,trade_id,confirmed_landed_cost) VALUES " +
          "(1,'MRSU4976363',2,10,1,50928.75)"
      );
      await client.query(
        "INSERT INTO intercompany_audit_events(event_key,relationship_id,source_company_id,event_type,payload) VALUES " +
          "('ic-container-import:1:1',1,1,'container-import-confirmed'," +
          '\'{"physicalContainerId":10,"originalSupplierVoucherIds":[51],"sourceSaleVoucherId":53,"sourceCostVoucherId":54,"destinationVoucherId":52}\'::jsonb)'
      );
      await client.query(
        "INSERT INTO accounting_posting_requests(company_id,voucher_id,source_type) VALUES (1,51,'ic-container-source'),(2,52,'ic-container-destination'),(1,53,'ic-container-sale'),(1,54,'ic-container-cost')"
      );

      // Ordinary partial deletion must be refused.
      await client.query("SAVEPOINT forbidden");
      await expect(client.query("DELETE FROM purchase_orders WHERE id=22")).rejects.toThrow(/synchronized/);
      await client.query("ROLLBACK TO SAVEPOINT forbidden");
      await client.query("RELEASE SAVEPOINT forbidden");

      // Same ordering as the application service: explicitly scoped line-link
      // deletion, detach trade, then original POs and engine vouchers.
      await client.query("SELECT set_config('erp.ic_physical_delete','1',true)");
      await client.query("DELETE FROM intercompany_trade_line_links WHERE trade_id=1");
      await client.query("DELETE FROM intercompany_trade_source_pos WHERE trade_id=1");
      await client.query("DELETE FROM intercompany_import_batch_containers WHERE trade_id=1");
      await client.query("DELETE FROM intercompany_trades WHERE id=1");
      await client.query("DELETE FROM po_line_items WHERE po_id IN (21,22)");
      await client.query("DELETE FROM purchase_orders WHERE id IN (21,22)");
      await client.query("DELETE FROM accounting_posting_requests WHERE voucher_id IN (51,52,53,54)");
      await client.query("DELETE FROM vouchers WHERE id IN (51,52,53,54)");
      await client.query("DELETE FROM container_charges WHERE container_id=10");
      await client.query("DELETE FROM containers WHERE id=10");
      await client.query("DELETE FROM intercompany_import_batches WHERE id=1");
      await client.query("SELECT set_config('erp.ic_physical_delete','',true)");
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");

      for (const [table, where] of [
        ["intercompany_trades", "id=1"],
        ["purchase_orders", "id IN (21,22)"],
        ["vouchers", "id IN (51,52,53,54)"],
        ["voucher_entries", "voucher_id IN (51,52,53,54)"],
        ["accounting_posting_requests", "voucher_id IN (51,52,53,54)"],
        ["containers", "id=10"],
      ]) {
        const result = await client.query("SELECT count(*)::int AS total FROM " + table + " WHERE " + where);
        expect(result.rows[0].total, table).toBe(0);
      }
      expect((await client.query("SELECT count(*)::int AS n FROM vouchers WHERE id=55")).rows[0].n).toBe(1);
      expect((await client.query("SELECT count(*)::int AS n FROM containers WHERE id=11")).rows[0].n).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  }, 90_000);
});
