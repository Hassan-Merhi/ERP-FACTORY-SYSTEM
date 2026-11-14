import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  intercompanyDestinationReceipts,
  intercompanyDestinationReceiptItems,
  intercompanyTradeCancellations,
} from "../shared/schema";

const migrationNames = [
  "20261105_001_intercompany_phase1_foundation.sql",
  "20261105_002_intercompany_phase2_import.sql",
  "20261105_003_intercompany_phase3_sync.sql",
  "20261105_004_intercompany_phase4_payments.sql",
  "20261105_005_intercompany_phase5_lifecycle.sql",
];
const migrations = migrationNames.map((file) => readFileSync(join(process.cwd(), "migrations", file), "utf8"));

describe("Phase 5 destination inventory and pre-receipt cancellation database guards", () => {
  it("registers all three receipt/cancellation models and the exact fifth migration", () => {
    expect(getTableConfig(intercompanyDestinationReceipts).name).toBe("intercompany_destination_receipts");
    expect(getTableConfig(intercompanyDestinationReceiptItems).name).toBe("intercompany_destination_receipt_items");
    expect(getTableConfig(intercompanyTradeCancellations).name).toBe("intercompany_trade_cancellations");
    const journal = JSON.parse(readFileSync(join(process.cwd(), "migrations/meta/_journal.json"), "utf8"));
    expect(
      journal.entries.filter((entry: { tag: string }) => entry.tag === "20261105_005_intercompany_phase5_lifecycle")
    ).toHaveLength(1);
    expect(migrations[4]).toContain("ic_phase5_exact_cancel_journal");
    expect(migrations[4]).toContain("ic_destination_receipt_item_sum");
    expect(migrations[4]).toContain("must cover all linked purchase stock items");
    expect(migrations[4]).toContain("ic_phase5_no_reprice_received_trade");
    expect(migrations[4]).toContain("cancel_release");
  });

  it("rejects partial receiving, wrong company/cost, single-sided cancellation and later edits", async () => {
    if (!process.env.DATABASE_URL) return;
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    });
    await client.connect();
    const schema = "ic_phase5_probe_" + process.pid;
    await client.query("BEGIN");
    try {
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
          "CREATE TABLE purchase_orders(id integer PRIMARY KEY,company_id integer,container_id integer,voucher_id integer,po_number text,items_total numeric,freight numeric,surcharge numeric,fumigation numeric,document_charges numeric,discount numeric,other_charges numeric,charges_edited boolean);" +
          "CREATE TABLE voucher_entries(id serial PRIMARY KEY,voucher_id integer,bank_account_id integer,ledger_account_id integer,supplier_id integer,debit_amount numeric,credit_amount numeric);" +
          "CREATE TABLE po_line_items(id integer PRIMARY KEY,po_id integer,stock_item_id integer,item_name text,quantity numeric,rate numeric,line_total numeric);" +
          "CREATE TABLE container_charges(id serial PRIMARY KEY,container_id integer,charge_type text,amount numeric,ledger_account_id integer);" +
          "CREATE TABLE container_offloads(id serial PRIMARY KEY,container_id integer);" +
          "CREATE TABLE locations(id integer PRIMARY KEY,company_id integer,deleted_at timestamp);" +
          "CREATE TABLE stock_items(id integer PRIMARY KEY,company_id integer);" +
          "CREATE TABLE canonical_stock_movements(id bigint PRIMARY KEY,company_id integer,stock_item_id integer,location_id integer,movement_kind text,source_type text,source_id text,quantity_delta numeric,unit_cost numeric);"
      );
      for (const ddl of migrations) await client.query(ddl);
      await client.query("INSERT INTO companies VALUES (1,'Hassan Properties'),(2,'HADI'),(3,'MALI')");
      await client.query("INSERT INTO users VALUES ('owner')");
      await client.query("INSERT INTO user_company_roles VALUES ('owner',1,'Owner')");
      await client.query(
        "INSERT INTO ledger_accounts(id,company_id,code,account_type,active) VALUES (11,1,'AR','Asset',true),(12,1,'PURCHASES','Asset',true),(13,1,'SALES','Income',true),(14,1,'COGS','Expense',true),(15,2,'AP','Liability',true),(16,2,'GIT','Asset',true),(17,1,'CHARGE','Liability',true),(18,3,'AP','Liability',true),(19,3,'GIT','Asset',true),(26,2,'INVENTORY','Asset',true),(29,3,'INVENTORY','Asset',true)"
      );
      await client.query("INSERT INTO bank_accounts(id,company_id,active) VALUES (31,1,true),(32,2,true),(33,3,true)");
      await client.query(
        "INSERT INTO suppliers(id,company_id,active,legal_name) VALUES (1,1,true,'Eurogulf'),(2,2,true,'Hassan Properties'),(3,3,true,'Hassan Properties')"
      );
      await client.query("INSERT INTO locations VALUES (301,2,NULL),(302,3,NULL)");
      await client.query("INSERT INTO stock_items VALUES (501,2),(502,3),(503,3)");
      await client.query(
        "INSERT INTO containers(id,company_id,supplier_id,status,container_number,items_total,charges_total,grand_total) VALUES (10,1,1,'OTW','IC-A',100,0,100),(11,1,1,'OTW','IC-B',100,0,100)"
      );
      await client.query(
        "INSERT INTO vouchers(id,company_id,voucher_type,total_amount,description) VALUES (51,1,'Purchase',100,'External A'),(52,2,'Purchase',100,'Linked A'),(53,1,'Purchase',100,'External B'),(54,3,'Purchase',100,'Linked B'),(55,1,'Receipt',120,'Real bank received'),(56,2,'Payment',120,'Real bank paid')"
      );
      await client.query(
        "INSERT INTO voucher_entries(voucher_id,bank_account_id,ledger_account_id,supplier_id,debit_amount,credit_amount) VALUES (55,31,NULL,NULL,120,0),(55,NULL,11,NULL,0,120),(56,NULL,NULL,2,120,0),(56,32,NULL,NULL,0,120)"
      );
      await client.query(
        "INSERT INTO purchase_orders(id,company_id,container_id,voucher_id,po_number,items_total,freight,surcharge,fumigation,document_charges,discount,other_charges) VALUES (21,1,10,51,'EXT-A',100,0,0,0,0,0,0),(22,2,10,52,'IC-A',100,0,0,0,0,0,0),(23,1,11,53,'EXT-B',100,0,0,0,0,0,0),(24,3,11,54,'IC-B',100,0,0,0,0,0,0)"
      );
      await client.query(
        "INSERT INTO po_line_items(id,po_id,stock_item_id,item_name,quantity,rate,line_total) VALUES (61,21,501,'A',10,10,100),(62,22,501,'A',10,10,100),(63,23,502,'B',10,10,100),(64,24,502,'B',10,10,100),(65,23,503,'Bonus',1,0,0),(66,24,503,'Bonus',1,0,0)"
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
        "INSERT INTO intercompany_import_batches(source_company_id,file_name,file_sha256,request_fingerprint,state,created_by) VALUES (1,'ic.xlsx',repeat('a',64),repeat('b',64),'confirmed','owner')"
      );
      await client.query(
        "INSERT INTO intercompany_import_batch_containers(batch_id,container_number,destination_company_id,physical_container_id,trade_id,confirmed_landed_cost) VALUES (1,'IC-A',2,10,1,100),(1,'IC-B',3,11,2,100)"
      );
      let count = 0;
      const rejects = async (query: string, fragment?: string) => {
        const save = "phase5_reject_" + ++count;
        await client.query("SAVEPOINT " + save);
        let failure = "";
        try {
          await client.query(query);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        } catch (error) {
          failure = String(error);
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT " + save);
          await client.query("RELEASE SAVEPOINT " + save);
        }
        expect(failure, query).not.toBe("");
        if (fragment) expect(failure).toContain(fragment);
      };
      // One real payment, applied only to HADI. Never generate a bank voucher for credit release.
      await client.query(
        "INSERT INTO intercompany_container_payments(relationship_id,source_company_id,destination_company_id,request_key,request_fingerprint,transfer_reference,confirmation_evidence,payment_date,transaction_currency,transaction_amount,historical_rate,base_amount,source_cash_type,source_cash_id,destination_cash_type,destination_cash_id,source_receivable_account_id,destination_supplier_id,source_receipt_voucher_id,destination_payment_voucher_id,created_by) VALUES (1,1,2,'phase5-real-money',repeat('c',64),'WIRE-PHASE5','Two statements confirm money','2026-11-05','USD',120,1,120,'bank',31,'bank',32,11,2,55,56,'owner')"
      );
      await client.query(
        "INSERT INTO intercompany_payment_allocations(payment_id,trade_id,amount,allocation_kind,request_key,reason) VALUES (1,1,40,'manual','phase5-credit-before','Original HADI payment')"
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await rejects(
        "INSERT INTO intercompany_payment_allocations(payment_id,trade_id,amount,allocation_kind,request_key,reason) VALUES (1,2,10,'manual','phase5-credit-wrong','Cannot pay MALI')",
        "same active company pair"
      );

      // Prepare THREE actual reversal journals for unreceived HADI trade.
      await client.query(
        "INSERT INTO vouchers(id,company_id,voucher_type,total_amount,description) VALUES (101,1,'Journal',100,'Cancel source sale'),(102,1,'Journal',100,'Cancel source COGS'),(103,2,'Journal',100,'Cancel destination GIT'),(104,2,'Journal',100,'Wrong GIT lines')"
      );
      await client.query(
        "INSERT INTO voucher_entries(voucher_id,ledger_account_id,supplier_id,debit_amount,credit_amount) VALUES (101,13,NULL,100,0),(101,11,NULL,0,100),(102,12,NULL,100,0),(102,14,NULL,0,100),(103,NULL,2,100,0),(103,16,NULL,0,100),(104,16,NULL,100,0),(104,NULL,2,0,100)"
      );
      await rejects(
        "UPDATE intercompany_trades SET state='canceled',version=2,canceled_at=now() WHERE id=1",
        "synchronized Phase 5"
      );
      const cancelColumns =
        "(trade_id,relationship_id,source_company_id,destination_company_id,request_key,request_fingerprint,expected_version,posting_date,landed_cost,source_sale_reversal_voucher_id,source_cost_reversal_voucher_id,destination_git_reversal_voucher_id,reason,cancellation_evidence,released_credit,actor_user_id)";
      await rejects(
        "INSERT INTO intercompany_trade_cancellations" +
          cancelColumns +
          " VALUES (1,1,1,2,'phase5-unscoped',repeat('d',64),1,'2026-11-05',100,101,102,103,'No goods arrived','Freight forwarder returned goods',40,'owner')",
        "same atomic cancellation transaction"
      );
      await client.query("SELECT set_config('erp.ic_phase5_cancel','1',true)");
      await rejects(
        "INSERT INTO intercompany_trade_cancellations" +
          cancelColumns +
          " VALUES (1,1,1,2,'phase5-wrong-voucher',repeat('d',64),1,'2026-11-05',100,101,102,104,'No goods arrived','Freight forwarder returned goods',40,'owner')",
        "reversal journal lines"
      );
      await client.query("SELECT set_config('erp.ic_phase5_cancel','',true)");
      await rejects(
        "INSERT INTO intercompany_payment_allocations(payment_id,trade_id,amount,allocation_kind,request_key,reason) VALUES (1,1,-40,'cancel_release','phase5-unscoped-release','Must be atomic')",
        "atomic cancellation"
      );
      await client.query("SELECT set_config('erp.ic_phase5_cancel','1',true)");
      await client.query(
        "INSERT INTO intercompany_payment_allocations(payment_id,trade_id,amount,allocation_kind,request_key,reason) VALUES (1,1,-40,'cancel_release','phase5-credit-return','Return to same original payment')"
      );
      await client.query(
        "INSERT INTO intercompany_trade_cancellations" +
          cancelColumns +
          " VALUES (1,1,1,2,'phase5-good-cancel',repeat('d',64),1,'2026-11-05',100,101,102,103,'Goods never arrived','Freight forwarder verified cancellation',40,'owner')"
      );

      await client.query("UPDATE intercompany_trades SET state='canceled',version=2,canceled_at=now() WHERE id=1");
      await client.query("SELECT set_config('erp.ic_phase5_cancel','',true)");
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await rejects("UPDATE purchase_orders SET items_total=99 WHERE id=22", "immutable");
      await rejects("UPDATE intercompany_trades SET version=version+1 WHERE id=1", "immutable");
      await rejects("UPDATE containers SET status='OFFLOADED' WHERE id=10", "cannot be altered");
      await rejects("UPDATE vouchers SET description='rewrite' WHERE id=103", "immutable");
      await rejects(
        "UPDATE intercompany_trade_cancellations SET reason='rewrite' WHERE trade_id=1",
        "cannot be modified"
      );
      const credit = await client.query(
        "SELECT COALESCE(sum(amount),0)::text AS used FROM intercompany_payment_allocations WHERE trade_id=1"
      );
      expect(Number(credit.rows[0].used)).toBe(0);
      const originalCash = await client.query("SELECT count(*)::int AS count FROM vouchers WHERE id IN (55,56)");
      expect(originalCash.rows[0].count).toBe(2);
      const cancellationJournalTotals = await client.query(
        "SELECT v.id, v.company_id, SUM(e.debit_amount) AS dr, SUM(e.credit_amount) AS cr, " +
          "COUNT(e.bank_account_id)::int AS cash_legs FROM vouchers v " +
          "JOIN voucher_entries e ON e.voucher_id=v.id " +
          "WHERE v.id IN (101,102,103) GROUP BY v.id,v.company_id ORDER BY v.id"
      );
      expect(
        cancellationJournalTotals.rows.map((row) => [
          Number(row.id),
          Number(row.company_id),
          Number(row.dr),
          Number(row.cr),
          row.cash_legs,
        ])
      ).toEqual([
        [101, 1, 100, 100, 0],
        [102, 1, 100, 100, 0],
        [103, 2, 100, 100, 0],
      ]);
      const canceledPair = await client.query("SELECT state,version FROM intercompany_trades WHERE id=1");
      expect(canceledPair.rows[0]).toMatchObject({ state: "canceled", version: 2 });

      // Receive other pair's goods: ONLY MALI inventory and destination GIT.
      await client.query(
        "INSERT INTO vouchers(id,company_id,voucher_type,total_amount,description) VALUES (201,3,'Journal',100,'MALI received stock'),(202,3,'Journal',100,'Wrong inventory line')"
      );
      await client.query(
        "INSERT INTO voucher_entries(voucher_id,ledger_account_id,debit_amount,credit_amount) VALUES (201,29,100,0),(201,19,0,100),(202,19,100,0),(202,29,0,100)"
      );
      await client.query(
        "INSERT INTO canonical_stock_movements(id,company_id,stock_item_id,location_id,movement_kind,source_type,source_id,quantity_delta,unit_cost) VALUES (301,3,502,302,'receipt','intercompany-destination-receipt','2',10,10),(302,3,503,302,'receipt','intercompany-destination-receipt','2',1,0)"
      );
      const receiveColumns =
        "(trade_id,relationship_id,destination_company_id,location_id,inventory_account_id,git_account_id,receipt_voucher_id,request_key,request_fingerprint,posting_date,landed_cost,arrival_evidence,reason,actor_user_id)";
      await rejects(
        "INSERT INTO intercompany_destination_receipts" +
          receiveColumns +
          " VALUES (2,2,3,301,29,19,201,'phase5-wrong-location',repeat('e',64),'2026-11-05',100,'Signed arrival evidence','Received warehouse','owner')",
        "receipt ownership"
      );
      await rejects(
        "INSERT INTO intercompany_destination_receipts" +
          receiveColumns +
          " VALUES (2,2,3,302,29,19,202,'phase5-wrong-account',repeat('e',64),'2026-11-05',100,'Signed arrival evidence','Received warehouse','owner')",
        "exact inventory/GIT"
      );
      // Earlier cancellation assertions switched constraints to IMMEDIATE.
      // A real receipt inserts its header and stock items as one deferred transaction.
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      // Rejected receipt attempts consumed sequence values; pin fixture ID for item rows.
      await client.query(
        "INSERT INTO intercompany_destination_receipts(id," +
          receiveColumns.slice(1) +
          " VALUES (1,2,2,3,302,29,19,201,'phase5-good-receipt',repeat('e',64),'2026-11-05',100,'Signed arrival evidence','Received warehouse','owner')"
      );
      await rejects("SET CONSTRAINTS ALL IMMEDIATE", "received destination item values");
      await client.query(
        "INSERT INTO intercompany_destination_receipt_items(receipt_id,stock_item_id,quantity,landed_value,value_moved,canonical_movement_id) VALUES (1,502,10,100,100,301)"
      );
      // The receipt value balances, but the zero-price bonus item is missing.
      await rejects("SET CONSTRAINTS ALL IMMEDIATE", "cover all linked purchase stock items");
      await client.query(
        "INSERT INTO intercompany_destination_receipt_items(receipt_id,stock_item_id,quantity,landed_value,value_moved,canonical_movement_id) VALUES (1,503,1,0,0,302)"
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      const destinationStock = await client.query(
        "SELECT stock_item_id,quantity,landed_value FROM intercompany_destination_receipt_items " +
          "WHERE receipt_id=1 ORDER BY stock_item_id"
      );
      expect(
        destinationStock.rows.map((row) => [Number(row.stock_item_id), Number(row.quantity), Number(row.landed_value)])
      ).toEqual([
        [502, 10, 100],
        [503, 1, 0],
      ]);
      const receiptJournal = await client.query(
        "SELECT ledger_account_id,debit_amount,credit_amount,bank_account_id,supplier_id " +
          "FROM voucher_entries WHERE voucher_id=201 ORDER BY ledger_account_id"
      );
      expect(
        receiptJournal.rows.map((row) => [
          row.ledger_account_id,
          Number(row.debit_amount),
          Number(row.credit_amount),
          row.bank_account_id,
          row.supplier_id,
        ])
      ).toEqual([
        [19, 0, 100, null, null],
        [29, 100, 0, null, null],
      ]);
      await rejects(
        "INSERT INTO intercompany_destination_receipt_items(receipt_id,stock_item_id,quantity,landed_value,value_moved,canonical_movement_id) VALUES (1,501,1,0,0,302)",
        "destination"
      );
      await rejects(
        "INSERT INTO intercompany_trade_revisions(trade_id,revision_number,kind,request_key,actor_user_id,initiating_company_id,amount_before,amount_after,posting_date,reason) VALUES (2,2,'line_edit','after-mali-received','owner',1,100,99,'2026-11-05','Unsafe stock recost')",
        "already received"
      );
      await rejects("UPDATE intercompany_trades SET state='canceled',version=2,canceled_at=now() WHERE id=2", "needs");
      await rejects("UPDATE vouchers SET description='alter destination' WHERE id=201", "immutable");
      const physical = await client.query("SELECT company_id,status FROM containers WHERE id=11");
      expect(physical.rows[0]).toMatchObject({ company_id: 1, status: "OTW" });
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  }, 90_000);
});
