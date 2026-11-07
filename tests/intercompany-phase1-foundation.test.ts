/**
 * Phase 1 isolation and safety test. Executes the real additive migration in
 * an ephemeral PostgreSQL schema, then ROLLBACK removes all fixtures and tables.
 * Never mutates the ERP tables in public or any actual company data.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  intercompanyRelationshipPolicies,
  intercompanyTrades,
  intercompanyImportBatches,
  intercompanyImportBatchContainers,
  intercompanyPermissionGrants,
  intercompanyAuditEvents,
  intercompanyReconciliationRuns,
  intercompanyReconciliationFindings,
  intercompanyRepairRequests,
} from "../shared/schema";

const SQL_FILE = join(process.cwd(), "migrations", "20261105_001_intercompany_phase1_foundation.sql");
const MIGRATION = readFileSync(SQL_FILE, "utf8");

describe("intercompany phase 1 foundation", () => {
  it("exports all nine inert, independent tables", () => {
    const expected = [
      [intercompanyRelationshipPolicies, "intercompany_relationship_policies"],
      [intercompanyTrades, "intercompany_trades"],
      [intercompanyImportBatches, "intercompany_import_batches"],
      [intercompanyImportBatchContainers, "intercompany_import_batch_containers"],
      [intercompanyPermissionGrants, "intercompany_permission_grants"],
      [intercompanyAuditEvents, "intercompany_audit_events"],
      [intercompanyReconciliationRuns, "intercompany_reconciliation_runs"],
      [intercompanyReconciliationFindings, "intercompany_reconciliation_findings"],
      [intercompanyRepairRequests, "intercompany_repair_requests"],
    ] as const;
    for (const [table, name] of expected) {
      expect(getTableConfig(table).name).toBe(name);
      expect(MIGRATION).toContain("CREATE TABLE IF NOT EXISTS " + name);
    }
  });

  it("registers the additive migration in the ordered migration journal", () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), "migrations/meta/_journal.json"), "utf8"));
    const tags = journal.entries.map((item: { tag: string }) => item.tag);
    expect(tags.filter((tag: string) => tag === "20261105_001_intercompany_phase1_foundation")).toHaveLength(1);
    expect(journal.entries.every((item: { idx: number }, i: number) => item.idx === i)).toBe(true);
  });

  it("enforces relation, source ownership, uniqueness, grant and audit protections in PostgreSQL", async () => {
    if (!process.env.DATABASE_URL) return;
    const connectionString = process.env.DATABASE_URL;
    const ssl = process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false };
    const client = new Client({ connectionString, ssl });
    await client.connect();

    // Entire probe runs in one rolled-back transaction, including schema creation.
    const probe = "intercompany_phase1_probe_" + process.pid;
    await client.query("BEGIN");
    try {
      await client.query("CREATE SCHEMA " + probe);
      await client.query("SET LOCAL search_path TO " + probe);
      await client.query(
        "CREATE TABLE companies (id integer PRIMARY KEY);" +
          "CREATE TABLE users (id varchar PRIMARY KEY);" +
          "CREATE TABLE user_company_roles (user_id varchar, company_id integer, role text);" +
          "CREATE TABLE ledger_accounts (id integer PRIMARY KEY, company_id integer, deleted_at timestamp);" +
          "CREATE TABLE containers (id integer PRIMARY KEY, company_id integer);" +
          "CREATE TABLE purchase_orders (id integer PRIMARY KEY, company_id integer, container_id integer);" +
          "CREATE TABLE vouchers (id integer PRIMARY KEY);"
      );
      await client.query(MIGRATION);
      await client.query("INSERT INTO companies(id) VALUES (1),(2),(3)");
      await client.query("INSERT INTO users(id) VALUES ('owner'),('editor')");
      await client.query("INSERT INTO user_company_roles(user_id,company_id,role) VALUES ('owner',1,'Owner')");
      await client.query("INSERT INTO ledger_accounts(id, company_id) VALUES (11,1),(22,2),(33,3)");
      await client.query("INSERT INTO containers(id, company_id) VALUES (100,1),(101,1)");
      await client.query(
        "INSERT INTO purchase_orders(id, company_id, container_id) VALUES (201,1,100),(202,2,100),(203,2,100),(204,1,101),(205,2,101)"
      );

      // PostgreSQL aborts the current transaction after a rejected statement:
      // savepoints keep later assertions running inside the same safe probe.
      let savepointCounter = 0;
      const rejects = async (statement: string, message?: string) => {
        const savepoint = "probe_" + ++savepointCounter;
        await client.query("SAVEPOINT " + savepoint);
        let rejected = false;
        try {
          await client.query(statement);
        } catch (error) {
          rejected = true;
          if (message) expect(String(error)).toContain(message);
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT " + savepoint);
          await client.query("RELEASE SAVEPOINT " + savepoint);
        }
        expect(rejected, "expected PostgreSQL to reject: " + statement).toBe(true);
      };

      // No relationship can enable historical auto-repair on its own.
      await client.query(
        "INSERT INTO intercompany_relationship_policies(source_company_id,destination_company_id,relationship_type) VALUES (1,2,'container_trade')"
      );
      const inactive = await client.query("SELECT * FROM intercompany_relationship_policies");
      expect(inactive.rows[0]).toMatchObject({
        trade_enabled: false,
        historical_repair_enabled: false,
        historical_audit_enabled: false,
        immediate_reconciliation_enabled: false,
        nightly_reconciliation_enabled: false,
        auto_repair_per_item_limit: null,
        auto_repair_daily_limit: null,
      });

      await rejects(
        "INSERT INTO intercompany_relationship_policies(source_company_id,destination_company_id,relationship_type) VALUES (1,1,'container_trade')"
      );
      await rejects("UPDATE intercompany_relationship_policies SET trade_enabled = true WHERE id = 1");
      await rejects(
        "UPDATE intercompany_relationship_policies SET source_receivable_account_id=22, destination_payable_account_id=11 WHERE id=1",
        "source company"
      );
      await rejects("UPDATE intercompany_relationship_policies SET historical_repair_enabled=true WHERE id=1");
      await client.query(
        "UPDATE intercompany_relationship_policies SET source_receivable_account_id=11, destination_payable_account_id=22, trade_enabled=true WHERE id=1"
      );

      // The physical container has only one ACTIVE trade; POs must belong to their company.
      await rejects(
        "INSERT INTO intercompany_trades(relationship_id,physical_container_id,source_company_id,destination_company_id,original_supplier_po_id,destination_po_id,state) VALUES (1,100,2,1,201,202,'active')"
      );
      await client.query(
        "INSERT INTO intercompany_trades(relationship_id,physical_container_id,source_company_id,destination_company_id,original_supplier_po_id,destination_po_id,state) VALUES (1,100,1,2,201,202,'active')"
      );
      await rejects(
        "INSERT INTO intercompany_trades(relationship_id,physical_container_id,source_company_id,destination_company_id,original_supplier_po_id,destination_po_id,state) VALUES (1,100,1,2,201,203,'active')"
      );
      await rejects(
        "INSERT INTO intercompany_trades(relationship_id,physical_container_id,source_company_id,destination_company_id,original_supplier_po_id,destination_po_id,state) VALUES (1,101,1,2,201,205,'active')"
      );
      await client.query(
        "INSERT INTO intercompany_trades(relationship_id,physical_container_id,source_company_id,destination_company_id,original_supplier_po_id,destination_po_id,state) VALUES (1,101,1,2,204,205,'active')"
      );

      // One import batch identity per source file, with a selected destination on every row.
      const hash = "a".repeat(64);
      await client.query(
        "INSERT INTO intercompany_import_batches(source_company_id,file_name,file_sha256,request_fingerprint) VALUES (1,'example.xlsx',$1,$1)",
        [hash]
      );
      await rejects(
        "INSERT INTO intercompany_import_batches(source_company_id,file_name,file_sha256,request_fingerprint) VALUES (1,'duplicate.xlsx','" +
          hash +
          "','" +
          hash +
          "')"
      );
      await client.query(
        "INSERT INTO intercompany_import_batch_containers(batch_id,container_number,destination_company_id) VALUES (1,'MSCU-001',2)"
      );
      await rejects(
        "INSERT INTO intercompany_import_batch_containers(batch_id,container_number,destination_company_id) VALUES (1,'MSCU-001',3)"
      );

      // Dedicated invoice access is explicit; NULL targets cannot bypass deduplication.
      await client.query(
        "INSERT INTO intercompany_permission_grants(user_id,granting_company_id,relationship_id,scope,invoice_key,granted_by) VALUES ('editor',1,1,'invoice','invoice-1','owner')"
      );
      await rejects(
        "INSERT INTO intercompany_permission_grants(user_id,granting_company_id,relationship_id,scope,invoice_key,granted_by) VALUES ('editor',1,1,'invoice','invoice-1','owner')"
      );
      await rejects(
        "INSERT INTO intercompany_permission_grants(user_id,granting_company_id,relationship_id,scope,granted_by) VALUES ('editor',1,1,'invoice','owner')"
      );
      await rejects(
        "INSERT INTO intercompany_permission_grants(user_id,granting_company_id,relationship_id,scope,invoice_key,granted_by) VALUES ('editor',1,1,'relationship','invoice-3','owner')"
      );
      await rejects(
        "INSERT INTO intercompany_permission_grants(user_id,granting_company_id,relationship_id,scope,invoice_key,granted_by) VALUES ('editor',1,1,'invoice','invoice-2','editor')",
        "Only an Owner or Developer"
      );
      await rejects(
        "INSERT INTO intercompany_permission_grants(user_id,granting_company_id,relationship_id,scope,invoice_key,granted_by) VALUES ('editor',3,1,'invoice','invoice-3','owner')",
        "participate"
      );
      await client.query("UPDATE intercompany_permission_grants SET revoked_at=NOW(), revoked_by='owner' WHERE id=1");
      await rejects("UPDATE intercompany_permission_grants SET revoked_by='editor' WHERE id=1", "cannot be altered");
      await rejects("DELETE FROM intercompany_permission_grants WHERE id=1", "must be revoked");
      await client.query(
        "INSERT INTO intercompany_permission_grants(user_id,granting_company_id,relationship_id,scope,invoice_key,granted_by) VALUES ('editor',1,1,'invoice','invoice-1','owner')"
      );

      // Audit records are append-only, including for privileged database clients.
      await client.query(
        "INSERT INTO intercompany_audit_events(event_key,source_company_id,event_type) VALUES ('event-1',1,'test')"
      );
      await rejects("UPDATE intercompany_audit_events SET event_type='changed' WHERE event_key='event-1'", "immutable");
      await rejects("DELETE FROM intercompany_audit_events WHERE event_key='event-1'", "immutable");

      // Repair requests are held by default; a valid gate requires an actor, baseline and both limits.
      await client.query(
        "UPDATE intercompany_relationship_policies SET historical_audit_enabled=true," +
          "historical_baseline_verified_at=NOW(),historical_repair_activated_at=NOW(),historical_repair_activated_by='owner'," +
          "auto_repair_per_item_limit=3000,auto_repair_daily_limit=7000,historical_repair_enabled=true WHERE id=1"
      );
      await client.query(
        "INSERT INTO intercompany_reconciliation_runs(relationship_id,run_kind,cutoff_date) VALUES (1,'baseline','2026-11-05')"
      );
      await client.query(
        "INSERT INTO intercompany_reconciliation_findings(run_id,relationship_id,finding_fingerprint) VALUES (1,1,'" +
          "b".repeat(64) +
          "')"
      );
      await client.query(
        "INSERT INTO intercompany_repair_requests(finding_id,relationship_id,request_key,evidence_fingerprint,absolute_base_amount,original_transaction_date) VALUES (1,1,'repair-1','" +
          "c".repeat(64) +
          "',100,'2026-03-01')"
      );
      const pending = await client.query("SELECT state, approved_at, posted_at FROM intercompany_repair_requests");
      expect(pending.rows[0]).toEqual({ state: "held", approved_at: null, posted_at: null });
      await rejects("UPDATE intercompany_repair_requests SET state='posted' WHERE id=1");
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  }, 60_000);
});
