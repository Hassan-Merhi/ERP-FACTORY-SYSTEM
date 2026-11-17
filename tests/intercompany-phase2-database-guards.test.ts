import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const phase1 = readFileSync(join(process.cwd(), "migrations/20261105_001_intercompany_phase1_foundation.sql"), "utf8");
const phase2 = readFileSync(join(process.cwd(), "migrations/20261105_002_intercompany_phase2_import.sql"), "utf8");

describe("Phase 2 PostgreSQL intercompany import safeguards", () => {
  it("enforces partner provenance and blocks old offload, edit and voucher paths", async () => {
    if (!process.env.DATABASE_URL) return;
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    });
    await client.connect();
    const schema = "intercompany_phase2_probe_" + process.pid;
    await client.query("BEGIN");
    try {
      await client.query("CREATE SCHEMA " + schema);
      await client.query("SET LOCAL search_path TO " + schema);
      await client.query(
        "CREATE TABLE companies (id integer PRIMARY KEY);" +
          "CREATE TABLE users (id varchar PRIMARY KEY);" +
          "CREATE TABLE user_company_roles (user_id varchar, company_id integer, role text);" +
          "CREATE TABLE ledger_accounts (id integer PRIMARY KEY, company_id integer, deleted_at timestamp);" +
          "CREATE TABLE suppliers (id integer PRIMARY KEY, company_id integer, active boolean, deleted_at timestamp);" +
          "CREATE TABLE containers (id integer PRIMARY KEY, company_id integer, supplier_id integer, container_number text, offload_date date, status text);" +
          "CREATE TABLE purchase_orders (id integer PRIMARY KEY, company_id integer, container_id integer, voucher_id integer, po_number text);" +
          "CREATE TABLE vouchers (id integer PRIMARY KEY, description text);" +
          "CREATE TABLE voucher_entries (id serial PRIMARY KEY, voucher_id integer, debit_amount numeric, credit_amount numeric);" +
          "CREATE TABLE po_line_items (id serial PRIMARY KEY, po_id integer);" +
          "CREATE TABLE container_charges (id serial PRIMARY KEY, container_id integer);" +
          "CREATE TABLE container_offloads (id serial PRIMARY KEY, container_id integer);"
      );
      await client.query(phase1);
      await client.query(phase2);
      await client.query("INSERT INTO companies(id) VALUES (1),(2),(3)");
      await client.query("INSERT INTO users(id) VALUES ('owner')");
      await client.query("INSERT INTO user_company_roles(user_id,company_id,role) VALUES ('owner',1,'Owner')");
      await client.query(
        "INSERT INTO ledger_accounts(id,company_id) VALUES (11,1),(12,1),(13,1),(14,1),(15,2),(16,2),(17,1)"
      );
      await client.query("INSERT INTO suppliers(id,company_id,active) VALUES (1,1,true),(2,2,true),(3,3,true)");
      await client.query("INSERT INTO containers(id,company_id,status) VALUES (10,1,'OTW'),(11,1,'OTW')");
      await client.query("INSERT INTO vouchers(id) VALUES (51),(52),(53),(54),(55)");
      await client.query(
        "INSERT INTO purchase_orders(id,company_id,container_id,voucher_id,po_number) VALUES (21,1,10,51,'EXT-1'),(22,2,10,52,'IC-1'),(23,1,11,NULL,'OTHER')"
      );

      let serial = 0;
      const rejects = async (statement: string, fragment?: string) => {
        const marker = "phase2_savepoint_" + ++serial;
        await client.query("SAVEPOINT " + marker);
        let errorMessage = "";
        try {
          await client.query(statement);
        } catch (error) {
          errorMessage = String(error);
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT " + marker);
          await client.query("RELEASE SAVEPOINT " + marker);
        }
        expect(errorMessage, statement).not.toBe("");
        if (fragment) expect(errorMessage).toContain(fragment);
      };

      await rejects(
        "INSERT INTO intercompany_relationship_policies(source_company_id,destination_company_id,relationship_type,trade_enabled) VALUES (1,2,'container_trade',true)",
        "check constraint"
      );
      await rejects(
        "INSERT INTO intercompany_relationship_policies(source_company_id,destination_company_id,relationship_type,destination_supplier_id) VALUES (1,2,'bad_supplier',3)",
        "destination supplier"
      );
      await client.query(
        "INSERT INTO intercompany_relationship_policies(" +
          "source_company_id,destination_company_id,relationship_type,trade_enabled," +
          "source_receivable_account_id,destination_payable_account_id,destination_supplier_id," +
          "source_purchase_account_id,source_sales_account_id,source_cost_account_id," +
          "source_charge_accrual_account_id,destination_git_account_id) " +
          "VALUES (1,2,'container_trade',true,11,15,2,12,13,14,17,16)"
      );
      await client.query(
        "INSERT INTO intercompany_trades(relationship_id,physical_container_id,source_company_id,destination_company_id," +
          "original_supplier_po_id,destination_po_id,state) VALUES ((SELECT id FROM intercompany_relationship_policies WHERE relationship_type='container_trade'),10,1,2,21,22,'active')"
      );
      await rejects(
        "INSERT INTO intercompany_trade_source_pos(trade_id,source_po_id,original_po_number) VALUES (1,23,'OTHER')",
        "physical container"
      );
      await client.query(
        "INSERT INTO intercompany_trade_source_pos(trade_id,source_po_id,original_po_number) VALUES (1,21,'EUROGULF-1')"
      );
      await rejects("INSERT INTO container_offloads(container_id) VALUES (10)", "Phase 5");
      await rejects("UPDATE containers SET status='OFFLOADED' WHERE id=10", "Phase 5");
      await rejects("UPDATE purchase_orders SET po_number='tampered' WHERE id=21", "Phase 3");
      await rejects("UPDATE purchase_orders SET po_number='tampered' WHERE id=22", "Phase 3");
      await rejects("INSERT INTO po_line_items(po_id) VALUES (22)", "Phase 3");
      await rejects("INSERT INTO container_charges(container_id) VALUES (10)", "Phase 3");
      await rejects("UPDATE vouchers SET description='tampered' WHERE id=51", "coordinated");
      await rejects("UPDATE vouchers SET description='tampered' WHERE id=52", "coordinated");
      await rejects("INSERT INTO voucher_entries(voucher_id,debit_amount) VALUES (51,123)", "coordinated");
      await rejects("INSERT INTO voucher_entries(voucher_id,credit_amount) VALUES (52,123)", "coordinated");
      await client.query("INSERT INTO voucher_entries(voucher_id,debit_amount) VALUES (55,12)");
      await rejects("UPDATE voucher_entries SET voucher_id=51 WHERE voucher_id=55", "Cannot move");
      await client.query(
        "INSERT INTO intercompany_audit_events(event_key,source_company_id,event_type,payload) " +
          "VALUES ('ic-container-import:1:1',1,'container-import-confirmed'," +
          '\'{"sourceSaleVoucherId":53,"sourceCostVoucherId":54}\'::jsonb)'
      );
      await rejects("UPDATE vouchers SET description='tampered' WHERE id=53", "coordinated");
      await rejects("UPDATE vouchers SET description='tampered' WHERE id=54", "coordinated");
      await rejects("INSERT INTO voucher_entries(voucher_id,credit_amount) VALUES (53,20)", "coordinated");
      await rejects("INSERT INTO voucher_entries(voucher_id,debit_amount) VALUES (54,20)", "coordinated");
      // Unrelated physical containers and vouchers are unaffected.
      await client.query("INSERT INTO container_offloads(container_id) VALUES (11)");
      await client.query("UPDATE vouchers SET description='unrelated' WHERE id=55");
      const [unrelatedVoucher] = (await client.query("SELECT description FROM vouchers WHERE id=55")).rows;
      expect(unrelatedVoucher.description).toBe("unrelated");
      await rejects("UPDATE containers SET container_number='changed' WHERE id=10", "ownership");
      await rejects("UPDATE containers SET offload_date=CURRENT_DATE WHERE id=10", "ownership");
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  }, 90_000);
});
