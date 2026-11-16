/**
 * Phase 7: test the real Stage 039–042 schema on DISPOSABLE PostgreSQL.
 *
 * Never run on a live/remote DB. The certification workflow sets
 * STO_WA_E2E_DISPOSABLE_DB=1 and localhost DATABASE_URL.
 */
import { describe, expect, it, afterAll } from "vitest";
import { Pool } from "pg";
import { ensureStockTransferOrderWhatsAppApprovalSchema } from "../server/startup/ensureStockTransferOrderWhatsAppApprovalSchema";

const url = process.env.DATABASE_URL || "";
const disposable = process.env.STO_WA_E2E_DISPOSABLE_DB === "1" &&
  /^postgres(?:ql)?:\/\/[^@]+@(?:localhost|127\.0\.0\.1):5432\//.test(url);
const test = disposable ? it : it.skip;
const pool = disposable ? new Pool({ connectionString: url, ssl: false }) : null;

afterAll(async () => { await pool?.end(); });

describe("STO WhatsApp full schema certification (throwaway local PostgreSQL only)", () => {
  test("applies the complete foundation twice without destructive rewrites", async () => {
    const client = pool!;
    await ensureStockTransferOrderWhatsAppApprovalSchema(client);
    await ensureStockTransferOrderWhatsAppApprovalSchema(client);
    const tables = await client.query<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables " +
      "WHERE table_schema='public' AND table_name LIKE 'stock_transfer_order_%' " +
      "ORDER BY table_name"
    );
    const names = tables.rows.map(v => v.name);
    for(const name of [
      "stock_transfer_order_approval_settings",
      "stock_transfer_order_destination_recipients",
      "stock_transfer_order_approval_batches",
      "stock_transfer_order_approval_batch_items",
      "stock_transfer_order_approval_batch_revisions",
      "stock_transfer_order_approval_events",
      "stock_transfer_order_approval_deliveries",
      "stock_transfer_order_approval_workbooks",
    ]) expect(names).toContain(name);
  }, 90000);

  test("enforces batch-decision uniqueness, protected evidence and retry cap", async () => {
    const constraints = await pool!.query<{ conname: string; definition: string }>(
      "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint " +
      "WHERE conname IN ('sto_wa_delivery_status_ck','sto_wa_event_type_ck'," +
      "'sto_wa_manual_retry_count_ck') ORDER BY conname"
    );
    const byName = new Map(constraints.rows.map(r => [r.conname,r.definition]));
    expect(byName.get("sto_wa_delivery_status_ck")).toContain("'verified'");
    expect(byName.get("sto_wa_event_type_ck")).toContain("'delivery_manual_retry'");
    expect(byName.get("sto_wa_manual_retry_count_ck")).toContain("manual_retry_count");
    const indexes = await pool!.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND " +
      "indexname IN ('sto_wa_event_dedupe_uk','sto_wa_batch_decision_once_uk'," +
      "'sto_wa_delivery_claim_expiry_idx','sto_wa_active_transfer_uk')"
    );
    expect(indexes.rows).toHaveLength(4);
    const triggers = await pool!.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND " +
      "tgname IN ('sto_wa_events_immutable_trg','sto_wa_revisions_immutable_trg'," +
      "'sto_wa_workbook_immutable_trg')"
    );
    expect(triggers.rows).toHaveLength(3);
  });

  test("uses forced row-level security on all eight approval tables", async () => {
    const res = await pool!.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class " +
      "WHERE relname IN ('stock_transfer_order_approval_settings'," +
      "'stock_transfer_order_destination_recipients'," +
      "'stock_transfer_order_approval_batches'," +
      "'stock_transfer_order_approval_batch_items'," +
      "'stock_transfer_order_approval_batch_revisions'," +
      "'stock_transfer_order_approval_events'," +
      "'stock_transfer_order_approval_deliveries'," +
      "'stock_transfer_order_approval_workbooks')"
    );
    expect(res.rows).toHaveLength(8);
    expect(res.rows.every(x => x.relrowsecurity && x.relforcerowsecurity)).toBe(true);
  });
});
