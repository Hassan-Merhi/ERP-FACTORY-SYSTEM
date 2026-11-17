import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { intercompanyContainerPayments, intercompanyPaymentAllocations } from "../shared/schema";

const scripts = [1, 2, 3, 4].map((number) => {
  const files = [
    "20261105_001_intercompany_phase1_foundation.sql",
    "20261105_002_intercompany_phase2_import.sql",
    "20261105_003_intercompany_phase3_sync.sql",
    "20261105_004_intercompany_phase4_payments.sql",
  ];
  return readFileSync(join(process.cwd(), "migrations", files[number - 1]), "utf8");
});

describe("Phase 4 paired payment database protections", () => {
  it("registers immutable cash transfer and credit tables", () => {
    expect(getTableConfig(intercompanyContainerPayments).name).toBe("intercompany_container_payments");
    expect(getTableConfig(intercompanyPaymentAllocations).name).toBe("intercompany_payment_allocations");
    const journal = JSON.parse(readFileSync(join(process.cwd(), "migrations/meta/_journal.json"), "utf8"));
    expect(
      journal.entries.filter((e: { tag: string }) => e.tag === "20261105_004_intercompany_phase4_payments")
    ).toHaveLength(1);
    expect(scripts[3]).toContain("ic_payment_allocation_append_only");
    expect(scripts[3]).toContain("ic_payment_voucher_guard");
  });
  it("rejects fabricated cross-company vouchers, moving credit and single-leg reversal", async () => {
    if (!process.env.DATABASE_URL) return;
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    });
    await client.connect();
    const schema = "ic_phase4_probe_" + process.pid;
    await client.query("BEGIN");
    try {
      await client.query("CREATE SCHEMA " + schema);
      await client.query("SET LOCAL search_path TO " + schema);
      await client.query(
        "CREATE TABLE companies(id integer PRIMARY KEY,name text);" +
          "CREATE TABLE users(id varchar PRIMARY KEY);" +
          "CREATE TABLE user_company_roles(user_id varchar,company_id integer,role text);" +
          "CREATE TABLE ledger_accounts(id integer PRIMARY KEY,company_id integer,account_type text,active boolean,deleted_at timestamp);" +
          "CREATE TABLE bank_accounts(id integer PRIMARY KEY,company_id integer,active boolean,deleted_at timestamp);" +
          "CREATE TABLE suppliers(id integer PRIMARY KEY,company_id integer,active boolean,deleted_at timestamp,legal_name text);" +
          "CREATE TABLE containers(id integer PRIMARY KEY,company_id integer,supplier_id integer,status text,container_number text,offload_date date,items_total numeric,charges_total numeric,grand_total numeric);" +
          "CREATE TABLE vouchers(id integer PRIMARY KEY,company_id integer,voucher_type text,total_amount numeric,deleted_at timestamp,description text,reversal_of_voucher_id integer);" +
          "CREATE TABLE purchase_orders(id integer PRIMARY KEY,company_id integer,container_id integer,voucher_id integer,po_number text,items_total numeric,freight numeric,surcharge numeric,fumigation numeric,document_charges numeric,discount numeric,other_charges numeric,charges_edited boolean);" +
          "CREATE TABLE voucher_entries(id serial PRIMARY KEY,voucher_id integer,bank_account_id integer,ledger_account_id integer,supplier_id integer,debit_amount numeric,credit_amount numeric);" +
          "CREATE TABLE po_line_items(id integer PRIMARY KEY,po_id integer,item_name text,quantity numeric,rate numeric,line_total numeric);" +
          "CREATE TABLE container_charges(id serial PRIMARY KEY,container_id integer,charge_type text,amount numeric,ledger_account_id integer);" +
          "CREATE TABLE container_offloads(id serial PRIMARY KEY,container_id integer);"
      );
      for (const script of scripts) await client.query(script);
      await client.query("INSERT INTO companies(id,name) VALUES (1,'Hassan Properties'),(2,'HADI LSHI'),(3,'MALI')");
      await client.query("INSERT INTO users(id) VALUES ('owner')");
      await client.query("INSERT INTO user_company_roles(user_id,company_id,role) VALUES ('owner',1,'Owner')");
      await client.query(
        "INSERT INTO ledger_accounts(id,company_id,account_type,active) VALUES (11,1,'Asset',true),(12,1,'Asset',true),(13,1,'Income',true),(14,1,'Expense',true),(15,2,'Liability',true),(16,2,'Asset',true),(17,1,'Liability',true),(18,3,'Liability',true),(19,3,'Asset',true),(20,1,'Cash',true)"
      );
      await client.query("INSERT INTO bank_accounts(id,company_id,active) VALUES (31,1,true),(32,2,true),(33,3,true)");
      await client.query(
        "INSERT INTO suppliers(id,company_id,active,legal_name) VALUES (1,1,true,'Eurogulf'),(2,2,true,'Hassan Properties'),(3,3,true,'Hassan Properties')"
      );
      await client.query(
        "INSERT INTO containers(id,company_id,status,container_number,items_total,charges_total,grand_total) VALUES (10,1,'OTW','CONT-A',100,0,100),(11,1,'OTW','CONT-B',100,0,100)"
      );
      await client.query(
        "INSERT INTO vouchers(id,company_id,voucher_type,total_amount,description) VALUES (51,1,'Purchase',100,'Original'),(52,2,'Purchase',100,'Destination'),(53,1,'Purchase',100,'Original2'),(54,3,'Purchase',100,'Destination2'),(55,1,'Receipt',120,'Bank received'),(56,2,'Payment',120,'Bank paid'),(57,1,'Payment',120,'Bank returned'),(58,2,'Receipt',120,'Bank refunded')"
      );
      await client.query(
        "INSERT INTO voucher_entries(voucher_id,bank_account_id,ledger_account_id,supplier_id,debit_amount,credit_amount) VALUES (55,31,NULL,NULL,120,0),(55,NULL,11,NULL,0,120),(56,NULL,NULL,2,120,0),(56,32,NULL,NULL,0,120),(57,NULL,11,NULL,120,0),(57,31,NULL,NULL,0,120),(58,32,NULL,NULL,120,0),(58,NULL,NULL,2,0,120)"
      );
      await client.query(
        "INSERT INTO purchase_orders(id,company_id,container_id,voucher_id,po_number,items_total,freight,surcharge,fumigation,document_charges,discount,other_charges) VALUES (21,1,10,51,'EXT-A',100,0,0,0,0,0,0),(22,2,10,52,'IC-A',100,0,0,0,0,0,0),(23,1,11,53,'EXT-B',100,0,0,0,0,0,0),(24,3,11,54,'IC-B',100,0,0,0,0,0,0)"
      );
      await client.query(
        "INSERT INTO po_line_items(id,po_id,item_name,quantity,rate,line_total) VALUES (61,21,'A',10,10,100),(62,22,'A',10,10,100),(63,23,'B',10,10,100),(64,24,'B',10,10,100)"
      );
      await client.query(
        "INSERT INTO intercompany_relationship_policies(source_company_id,destination_company_id,relationship_type,trade_enabled,source_receivable_account_id,destination_payable_account_id,destination_supplier_id,source_purchase_account_id,source_sales_account_id,source_cost_account_id,source_charge_accrual_account_id,destination_git_account_id) VALUES (1,2,'container_trade',true,11,15,2,12,13,14,17,16),(1,3,'container_trade',true,11,18,3,12,13,14,17,19)"
      );
      await client.query(
        "INSERT INTO intercompany_trades(relationship_id,physical_container_id,source_company_id,destination_company_id,original_supplier_po_id,destination_po_id,state) VALUES (1,10,1,2,21,22,'active'),(2,11,1,3,23,24,'active')"
      );
      await client.query(
        "INSERT INTO intercompany_trade_source_pos(trade_id,source_po_id,original_po_number) VALUES (1,21,'EXT-A'),(2,23,'EXT-B')"
      );
      await client.query(
        "INSERT INTO intercompany_import_batches(source_company_id,file_name,file_sha256,request_fingerprint,state,created_by) VALUES (1,'a.xlsx','" +
          "a".repeat(64) +
          "','" +
          "b".repeat(64) +
          "','confirmed','owner')"
      );
      await client.query(
        "INSERT INTO intercompany_import_batch_containers(batch_id,container_number,destination_company_id,physical_container_id,trade_id,confirmed_landed_cost) VALUES (1,'CONT-A',2,10,1,100),(1,'CONT-B',3,11,2,100)"
      );
      let attempt = 0;
      const rejects = async (query: string, fragment?: string) => {
        const save = "ic_payment_probe_" + ++attempt;
        await client.query("SAVEPOINT " + save);
        let error = "";
        try {
          await client.query(query);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        } catch (e) {
          error = String(e);
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT " + save);
          await client.query("RELEASE SAVEPOINT " + save);
        }
        expect(error, query).not.toBe("");
        if (fragment) expect(error).toContain(fragment);
      };
      const paymentColumns =
        "(relationship_id,source_company_id,destination_company_id,request_key,request_fingerprint,transfer_reference,confirmation_evidence,payment_date,transaction_currency,transaction_amount,historical_rate,base_amount,source_cash_type,source_cash_id,destination_cash_type,destination_cash_id,source_receivable_account_id,destination_supplier_id,source_receipt_voucher_id,destination_payment_voucher_id,created_by)";
      const goodValues =
        "(1,1,2,'phase4-key-001',repeat('a',64),'WIRE-REF-001','Bank receipt and payment verified','2026-11-05','USD',120,1,120,'bank',31,'bank',32,11,2,55,56,'owner')";
      await rejects(
        "INSERT INTO intercompany_container_payments" +
          paymentColumns +
          " VALUES (1,1,3,'phase4-wrong-pair',repeat('a',64),'WRONG-001','Both sides verified','2026-11-05','USD',120,1,120,'bank',31,'bank',33,11,2,55,56,'owner')",
        "pair"
      );
      await client.query(
        "INSERT INTO vouchers(id,company_id,voucher_type,total_amount,description) VALUES (60,1,'Receipt',120,'Wrong actual bank leg'),(61,2,'Payment',120,'Wrong supplier payable')"
      );
      await client.query(
        "INSERT INTO voucher_entries(voucher_id,bank_account_id,ledger_account_id,supplier_id,debit_amount,credit_amount) VALUES (60,33,NULL,NULL,120,0),(60,NULL,11,NULL,0,120),(61,NULL,NULL,3,120,0),(61,32,NULL,NULL,0,120)"
      );
      await rejects(
        "INSERT INTO intercompany_container_payments" +
          paymentColumns +
          " VALUES (1,1,2,'phase4-wrong-journal',repeat('a',64),'WRONG-LEG-001','Bank evidence differs from actual posting','2026-11-05','USD',120,1,120,'bank',31,'bank',32,11,2,60,61,'owner')",
        "voucher lines"
      );
      // A direct DB caller must not invent USD value or substitute a different
      // source receivable, even when authentic-looking voucher IDs are supplied.
      await rejects(
        "INSERT INTO intercompany_container_payments" +
          paymentColumns +
          " VALUES (1,1,2,'phase4-fake-fx',repeat('a',64),'WIRE-FX-001','Transfer evidence checked','2026-11-05','USD',100,1,120,'bank',31,'bank',32,11,2,55,56,'owner')",
        "ic_payments_fx_consistency"
      );
      await rejects(
        "INSERT INTO intercompany_container_payments" +
          paymentColumns +
          " VALUES (1,1,2,'phase4-fake-map',repeat('a',64),'WIRE-MAP-001','Transfer evidence checked','2026-11-05','USD',120,1,120,'bank',31,'bank',32,12,2,55,56,'owner')",
        "verified company-pair"
      );
      await rejects(
        "INSERT INTO intercompany_container_payments" +
          paymentColumns +
          " VALUES (1,1,2,'phase4-fake-usd-rate',repeat('a',64),'WIRE-RATE-001','Transfer evidence checked','2026-11-05','USD',120,2,120,'bank',31,'bank',32,11,2,55,56,'owner')",
        "ic_payments_fx_consistency"
      );
      await client.query("SAVEPOINT wrong_supplier_identity");
      await client.query("UPDATE suppliers SET legal_name='Unrelated Vendor' WHERE id=2");
      await rejects(
        "INSERT INTO intercompany_container_payments" + paymentColumns + " VALUES " + goodValues,
        "Original receivable/supplier identities"
      );
      await client.query("ROLLBACK TO SAVEPOINT wrong_supplier_identity");
      await client.query("RELEASE SAVEPOINT wrong_supplier_identity");
      // Rejected fixture INSERTs consume sequence numbers even after savepoint rollback.
      // Pin the genuine payment identity used by later credit/reversal assertions.
      await client.query(
        "INSERT INTO intercompany_container_payments(id," +
          paymentColumns.slice(1) +
          " VALUES (1," +
          goodValues.slice(1)
      );
      await client.query(
        "INSERT INTO vouchers(id,company_id,voucher_type,total_amount,description) VALUES (62,1,'Receipt',120,'Other bank reference'),(63,2,'Payment',120,'Other supplier reference')"
      );
      await client.query(
        "INSERT INTO voucher_entries(voucher_id,bank_account_id,ledger_account_id,supplier_id,debit_amount,credit_amount) VALUES (62,31,NULL,NULL,120,0),(62,NULL,11,NULL,0,120),(63,NULL,NULL,2,120,0),(63,32,NULL,NULL,0,120)"
      );
      await rejects(
        "INSERT INTO intercompany_container_payments" +
          paymentColumns +
          " VALUES (1,1,2,'phase4-repeat-reference',repeat('b',64),'wire-ref-001','Proof of second bank statement','2026-11-05','USD',120,1,120,'bank',31,'bank',32,11,2,62,63,'owner')",
        "ic_payments_pair_transfer_ref"
      );

      await rejects("UPDATE vouchers SET description='tampered' WHERE id=55", "Mirrored");
      await rejects("DELETE FROM vouchers WHERE id=56", "Mirrored");
      await rejects(
        "INSERT INTO vouchers(id,company_id,voucher_type,reversal_of_voucher_id) VALUES (59,1,'Payment',55)",
        "coordinated"
      );
      await rejects("UPDATE intercompany_container_payments SET transfer_reference='altered' WHERE id=1", "immutable");
      await client.query(
        "INSERT INTO intercompany_payment_allocations(payment_id,trade_id,amount,allocation_kind,request_key,reason) VALUES (1,1,80,'manual','phase4-allocation-1','Pay chosen container')"
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await rejects(
        "INSERT INTO intercompany_payment_allocations(payment_id,trade_id,amount,allocation_kind,request_key,reason) VALUES (1,2,10,'manual','phase4-wrong-company','Wrong destination')",
        "same active company pair"
      );
      await rejects(
        "INSERT INTO intercompany_payment_allocations(payment_id,trade_id,amount,allocation_kind,request_key,reason) VALUES (1,1,30,'manual','phase4-overpaid','Exceeds confirmed PO')",
        "exceed"
      );
      await rejects("UPDATE intercompany_payment_allocations SET amount=90 WHERE id=1", "append-only");
      await rejects(
        "UPDATE intercompany_trades SET state='canceled' WHERE id=1",
        "requires releasing original company-pair credit"
      );
      await rejects("UPDATE intercompany_trades SET relationship_id=2, destination_company_id=3 WHERE id=1");
      // Cost reductions must release excess paid credit without altering any cash vouchers.
      await client.query(
        "INSERT INTO intercompany_trade_revisions(trade_id,revision_number,kind,request_key,actor_user_id,initiating_company_id,amount_before,amount_after,posting_date,reason) VALUES (1,2,'line_edit','phase4-linked-edit','owner',1,100,50,'2026-11-05','Price reduction')"
      );
      await client.query("SELECT set_config('erp.ic_edit_revision','1',true)");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query("UPDATE po_line_items SET rate=5,line_total=50 WHERE id IN (61,62)");
      await client.query("UPDATE purchase_orders SET items_total=50 WHERE id IN (21,22)");
      await client.query("UPDATE containers SET items_total=50,grand_total=50 WHERE id=10");
      await client.query("UPDATE intercompany_import_batch_containers SET confirmed_landed_cost=50 WHERE trade_id=1");
      await rejects("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        "INSERT INTO intercompany_payment_allocations(payment_id,trade_id,amount,allocation_kind,request_key,reason) VALUES (1,1,-30,'edit_release','phase4-price-release','Return excess pair credit')"
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("UPDATE intercompany_trades SET version=2 WHERE id=1");
      await client.query("SELECT set_config('erp.ic_edit_revision','',true)");
      // Reversing the original cash transaction releases the remaining applied amount.
      await client.query(
        "INSERT INTO intercompany_payment_allocations(payment_id,trade_id,amount,allocation_kind,request_key,reason) VALUES (1,1,-50,'reversal_release','phase4-reversal-release','Reverse paired money')"
      );
      await client.query("SELECT set_config('erp.ic_payment_reversal','1',true)");
      await client.query(
        "UPDATE intercompany_container_payments SET status='reversed',reversed_by='owner',reversed_at=now(),reversal_date='2026-11-05',reversal_reason='Bank returned transfer',reversal_key='reversal-key-001',reversal_fingerprint=repeat('f',64),source_reversal_voucher_id=57,destination_reversal_voucher_id=58 WHERE id=1"
      );
      await client.query("SELECT set_config('erp.ic_payment_reversal','',true)");
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await rejects(
        "INSERT INTO intercompany_payment_allocations(payment_id,trade_id,amount,allocation_kind,request_key,reason) VALUES (1,1,5,'manual','phase4-after-reversal','Already reversed')",
        "same active company pair"
      );
      await rejects("UPDATE intercompany_container_payments SET status='confirmed' WHERE id=1", "immutable");
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  }, 90_000);
});
