import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  intercompanyTradeLineLinks,
  intercompanyTradeRevisions,
  intercompanySharedChargeInvoices,
  intercompanySharedChargeAllocations,
  intercompanySharedChargePoAllocations,
} from "../shared/schema";

const scripts = [
  "001_intercompany_phase1_foundation",
  "002_intercompany_phase2_import",
  "003_intercompany_phase3_sync",
].map((name) => readFileSync(join(process.cwd(), "migrations", "20261105_" + name + ".sql"), "utf8"));

describe("Phase 3 intercompany linked edit migration guards", () => {
  it("registers every source/destination revision and shared-charge table", () => {
    for (const [table, name] of [
      [intercompanyTradeLineLinks, "intercompany_trade_line_links"],
      [intercompanyTradeRevisions, "intercompany_trade_revisions"],
      [intercompanySharedChargeInvoices, "intercompany_shared_charge_invoices"],
      [intercompanySharedChargeAllocations, "intercompany_shared_charge_allocations"],
      [intercompanySharedChargePoAllocations, "intercompany_shared_charge_po_allocations"],
    ] as const) {
      expect(getTableConfig(table).name).toBe(name);
      expect(scripts[2]).toContain("CREATE TABLE IF NOT EXISTS " + name);
    }
    const journal = JSON.parse(readFileSync("migrations/meta/_journal.json", "utf8"));
    expect(
      journal.entries.filter((e: { tag: string }) => e.tag === "20261105_003_intercompany_phase3_sync")
    ).toHaveLength(1);
  });

  it("rejects standalone edits, locks original invoice totals and permits only live-version revisions", async () => {
    if (!process.env.DATABASE_URL) return;
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    });
    await client.connect();
    const schema = "ic_phase3_probe_" + process.pid;
    await client.query("BEGIN");
    try {
      await client.query("CREATE SCHEMA " + schema);
      await client.query("SET LOCAL search_path TO " + schema);
      await client.query(
        "CREATE TABLE companies(id integer PRIMARY KEY);" +
          "CREATE TABLE users(id varchar PRIMARY KEY);" +
          "CREATE TABLE user_company_roles(user_id varchar,company_id integer,role text);" +
          "CREATE TABLE ledger_accounts(id integer PRIMARY KEY,company_id integer,deleted_at timestamp);" +
          "CREATE TABLE suppliers(id integer PRIMARY KEY,company_id integer,active boolean,deleted_at timestamp);" +
          "CREATE TABLE containers(id integer PRIMARY KEY,company_id integer,supplier_id integer,status text,container_number text,offload_date date,items_total numeric,charges_total numeric,grand_total numeric);" +
          "CREATE TABLE vouchers(id integer PRIMARY KEY,description text);" +
          "CREATE TABLE purchase_orders(id integer PRIMARY KEY,company_id integer,container_id integer,voucher_id integer,po_number text,items_total numeric,freight numeric,surcharge numeric,fumigation numeric,document_charges numeric,discount numeric,other_charges numeric,charges_edited boolean);" +
          "CREATE TABLE voucher_entries(id serial PRIMARY KEY,voucher_id integer,debit_amount numeric,credit_amount numeric);" +
          "CREATE TABLE po_line_items(id integer PRIMARY KEY,po_id integer,item_name text,quantity numeric,rate numeric,line_total numeric);" +
          "CREATE TABLE container_charges(id serial PRIMARY KEY,container_id integer,charge_type text,amount numeric,ledger_account_id integer);" +
          "CREATE TABLE container_offloads(id serial PRIMARY KEY,container_id integer);"
      );
      for (const script of scripts) await client.query(script);
      await client.query("INSERT INTO companies(id) VALUES (1),(2),(3)");
      await client.query("INSERT INTO users(id) VALUES ('owner'),('editor')");
      await client.query(
        "INSERT INTO user_company_roles(user_id,company_id,role) VALUES ('owner',1,'Owner'),('editor',1,'Editor')"
      );
      await client.query(
        "INSERT INTO ledger_accounts(id,company_id) VALUES (11,1),(12,1),(13,1),(14,1),(15,2),(16,2),(17,1)"
      );
      await client.query("INSERT INTO suppliers(id,company_id,active) VALUES (1,1,true),(2,2,true)");
      await client.query(
        "INSERT INTO containers(id,company_id,status,container_number,items_total,charges_total,grand_total) VALUES (10,1,'OTW','IC-A',100,0,100)"
      );
      await client.query("INSERT INTO vouchers(id) VALUES (51),(52)");
      await client.query(
        "INSERT INTO purchase_orders(id,company_id,container_id,voucher_id,po_number,items_total,freight,surcharge,fumigation,document_charges,discount,other_charges) VALUES (21,1,10,51,'EXT-A',100,0,0,0,0,0,0),(22,2,10,52,'IC-A',100,0,0,0,0,0,0)"
      );
      await client.query(
        "INSERT INTO po_line_items(id,po_id,item_name,quantity,rate,line_total) VALUES (31,21,'A',10,10,100),(32,22,'A',10,10,100)"
      );
      await client.query(
        "INSERT INTO intercompany_relationship_policies(source_company_id,destination_company_id,relationship_type,trade_enabled,source_receivable_account_id,destination_payable_account_id,destination_supplier_id,source_purchase_account_id,source_sales_account_id,source_cost_account_id,source_charge_accrual_account_id,destination_git_account_id) VALUES (1,2,'container_trade',true,11,15,2,12,13,14,17,16)"
      );
      await client.query(
        "INSERT INTO intercompany_trades(relationship_id,physical_container_id,source_company_id,destination_company_id,original_supplier_po_id,destination_po_id,state) VALUES (1,10,1,2,21,22,'active')"
      );
      await client.query(
        "INSERT INTO intercompany_trade_source_pos(trade_id,source_po_id,original_po_number) VALUES (1,21,'EXT-A')"
      );
      await client.query(
        "INSERT INTO intercompany_trade_line_links(trade_id,source_line_id,destination_line_id,original_excel_row) VALUES (1,31,32,1)"
      );
      let index = 0;
      const rejects = async (query: string, fragment?: string) => {
        const save = "ic_save_" + ++index;
        await client.query("SAVEPOINT " + save);
        let received = "";
        try {
          await client.query(query);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        } catch (error) {
          received = String(error);
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT " + save);
          await client.query("RELEASE SAVEPOINT " + save);
        }
        expect(received, query).not.toBe("");
        if (fragment) expect(received).toContain(fragment);
      };
      await rejects("UPDATE purchase_orders SET items_total=101 WHERE id=21", "synchronized");
      await rejects("UPDATE po_line_items SET quantity=11 WHERE id=31", "synchronized");
      await rejects("UPDATE containers SET grand_total=110 WHERE id=10", "synchronized");
      await rejects("DELETE FROM intercompany_trade_line_links WHERE id=1", "immutable");
      await rejects("UPDATE intercompany_trade_line_links SET source_line_id=32 WHERE id=1", "immutable");
      await client.query(
        "INSERT INTO intercompany_trade_revisions(trade_id,revision_number,kind,request_key,actor_user_id,initiating_company_id,amount_before,amount_after,posting_date,reason) VALUES (1,2,'line_edit','phase3-test-key-1','owner',1,100,110,'2026-11-05','Correct source supplier price')"
      );
      await client.query("SELECT set_config('erp.ic_edit_revision','1',true)");
      await client.query("UPDATE po_line_items SET rate=11,line_total=110 WHERE id=31");
      await client.query("UPDATE po_line_items SET rate=11,line_total=110 WHERE id=32");
      await client.query("UPDATE purchase_orders SET items_total=110 WHERE id IN(21,22)");
      await client.query("UPDATE containers SET items_total=110,grand_total=110 WHERE id=10");
      await rejects("UPDATE po_line_items SET po_id=22 WHERE id=31", "pricing");
      await client.query("UPDATE intercompany_trades SET version=2 WHERE id=1");
      await rejects("UPDATE po_line_items SET rate=12 WHERE id=31", "synchronized");
      await client.query("SELECT set_config('erp.ic_edit_revision','',true)");
      await client.query(
        "INSERT INTO intercompany_shared_charge_invoices(source_company_id,external_invoice_key,charge_type,face_amount,evidence_reference,created_by,state) VALUES (1,'INVOICE-A','freight',50,'PDF-A','owner','draft')"
      );
      await client.query(
        "INSERT INTO intercompany_shared_charge_allocations(invoice_id,trade_id,amount) VALUES (1,1,50)"
      );
      await client.query(
        "INSERT INTO intercompany_shared_charge_po_allocations(invoice_id,trade_id,source_po_id,amount) VALUES (1,1,21,50)"
      );
      await client.query("UPDATE intercompany_shared_charge_invoices SET state='confirmed', confirmed_at=NOW() WHERE id=1");
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await rejects("UPDATE intercompany_shared_charge_invoices SET face_amount=51 WHERE id=1", "face");
      await rejects("UPDATE intercompany_shared_charge_allocations SET amount=40 WHERE id=1", "allocation");
      await rejects("UPDATE intercompany_shared_charge_po_allocations SET amount=40 WHERE id=1", "source PO");
      await client.query(
        "INSERT INTO intercompany_permission_grants(user_id,granting_company_id,relationship_id,scope,granted_by) VALUES ('editor',1,1,'relationship','owner')"
      );
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  }, 90_000);
});
