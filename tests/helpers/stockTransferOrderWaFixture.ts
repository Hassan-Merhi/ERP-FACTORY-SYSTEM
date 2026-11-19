/**
 * Self-contained Stock Transfer Order WhatsApp approval fixture: one company,
 * a source and two destination locations, one stock item, approval settings and
 * a destination recipient, plus helpers to add orders (voucher, transfer, line,
 * pending revision). The approval evidence tables are append-only by trigger,
 * so teardown runs as the superuser with triggers switched off for one
 * transaction (the same approach as tests/helpers/auditLogCleanup.ts).
 */
import { pool } from "../../server/db";

export const STO_GROUP_CHAT = "120363000000000777@g.us";
export const STO_DEST_CHAT = "243810000777@c.us";
export const STO_PHONE = "+243810000777";

export interface StoWaFixture {
  tag: string;
  companyId: number;
  sourceId: number;
  destinationId: number;
  otherDestinationId: number;
  stockItemId: number;
  configure(options?: { enabled?: boolean; recipient?: boolean }): Promise<void>;
  addOrder(options?: { destinationId?: number; lines?: boolean; revision?: boolean }): Promise<{
    transferId: number;
    voucherId: number;
    revisionId: number | null;
  }>;
  cleanup(): Promise<void>;
}

export async function createStoWaFixture(prefix: string): Promise<StoWaFixture> {
  const tag = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const company = await pool.query<{ id: number }>("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [
    tag.toUpperCase().slice(0, 40),
    `${tag}_Company`,
  ]);
  const companyId = company.rows[0].id;
  const location = async (suffix: string) =>
    (
      await pool.query<{ id: number }>("INSERT INTO locations(company_id,code,name) VALUES($1,$2,$3) RETURNING id", [
        companyId,
        `${tag}-${suffix}`.slice(0, 50),
        `${tag} ${suffix}`,
      ])
    ).rows[0].id;
  const sourceId = await location("SRC");
  const destinationId = await location("DST");
  const otherDestinationId = await location("DS2");
  const item = await pool.query<{ id: number }>(
    "INSERT INTO stock_items(company_id,code,name,uom) VALUES($1,$2,'Sacks','PCS') RETURNING id",
    [companyId, `${tag}-IT`.slice(0, 50)]
  );
  const stockItemId = item.rows[0].id;
  let orderSeq = 0;

  return {
    tag,
    companyId,
    sourceId,
    destinationId,
    otherDestinationId,
    stockItemId,
    async configure({ enabled = true, recipient = true } = {}) {
      await pool.query(
        `INSERT INTO stock_transfer_order_approval_settings(company_id,enabled,approval_group_chat_id,authorized_phone_e164,updated_at)
         VALUES($1,$2,$3,$4,now()-interval '1 hour')
         ON CONFLICT (company_id) DO UPDATE SET enabled=EXCLUDED.enabled,
           approval_group_chat_id=EXCLUDED.approval_group_chat_id,
           authorized_phone_e164=EXCLUDED.authorized_phone_e164, updated_at=EXCLUDED.updated_at`,
        [companyId, enabled, STO_GROUP_CHAT, STO_PHONE]
      );
      if (recipient) {
        await pool.query(
          `INSERT INTO stock_transfer_order_destination_recipients(company_id,destination_location_id,chat_id,enabled,updated_at)
           VALUES($1,$2,$3,true,now()-interval '1 hour')`,
          [companyId, destinationId, STO_DEST_CHAT]
        );
      }
    },
    async addOrder({ destinationId: dest = destinationId, lines = true, revision = true } = {}) {
      orderSeq += 1;
      const voucher = await pool.query<{ id: number }>(
        `INSERT INTO vouchers(company_id,voucher_type,voucher_number,voucher_date,total_amount)
         VALUES($1,'Stock Transfer',$2,'2026-03-01',0) RETURNING id`,
        [companyId, `${tag}-STO-${orderSeq}`]
      );
      const voucherId = voucher.rows[0].id;
      const transfer = await pool.query<{ id: number }>(
        `INSERT INTO stock_transfer_vouchers(voucher_id,source_location_id,destination_location_id,workflow_origin)
         VALUES($1,$2,$3,'stock_transfer_order') RETURNING id`,
        [voucherId, sourceId, dest]
      );
      const transferId = transfer.rows[0].id;
      if (lines) {
        await pool.query(
          `INSERT INTO stock_transfer_items(transfer_id,stock_item_id,source_location_id,quantity,rate,total_amount)
           VALUES($1,$2,$3,'5.000','2.00','10.00')`,
          [transferId, stockItemId, sourceId]
        );
      }
      let revisionId: number | null = null;
      if (revision) {
        const rev = await pool.query<{ id: number }>(
          `INSERT INTO stock_transfer_revisions(transfer_id,revision_number,status,payload_hash)
           VALUES($1,1,'pending',$2) RETURNING id`,
          [transferId, "a".repeat(64)]
        );
        revisionId = rev.rows[0].id;
      }
      return { transferId, voucherId, revisionId };
    },
    async cleanup() {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        for (const table of [
          "stock_transfer_order_approval_events",
          "stock_transfer_order_approval_deliveries",
          "stock_transfer_order_approval_workbooks",
          "stock_transfer_order_approval_batch_revisions",
          "stock_transfer_order_approval_batch_items",
          "stock_transfer_order_approval_batches",
          "stock_transfer_order_destination_recipients",
          "stock_transfer_order_approval_settings",
        ]) {
          await client.query(`DELETE FROM ${table} WHERE company_id=$1`, [companyId]);
        }
        const transfers = `SELECT t.id FROM stock_transfer_vouchers t JOIN vouchers v ON v.id=t.voucher_id WHERE v.company_id=$1`;
        await client.query(`DELETE FROM stock_transfer_revisions WHERE transfer_id IN (${transfers})`, [companyId]);
        await client.query(`DELETE FROM stock_transfer_items WHERE transfer_id IN (${transfers})`, [companyId]);
        await client.query(
          "DELETE FROM stock_transfer_vouchers WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id=$1)",
          [companyId]
        );
        await client.query("DELETE FROM vouchers WHERE company_id=$1", [companyId]);
        await client.query("DELETE FROM audit_log WHERE company_id=$1", [companyId]);
        await client.query("DELETE FROM stock_items WHERE company_id=$1", [companyId]);
        await client.query("DELETE FROM locations WHERE company_id=$1", [companyId]);
        await client.query("DELETE FROM companies WHERE id=$1", [companyId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
