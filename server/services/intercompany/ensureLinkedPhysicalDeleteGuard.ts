/**
 * Runtime readiness for the pristine intercompany physical-delete permission.
 *
 * The branch-testing Render service does not automatically run the Drizzle
 * migration journal. A recorded migration is not evidence that its PostgreSQL
 * trigger function is installed. This idempotent, no-DML catch-up applies only
 * the pre-reviewed 20261113_001 line-link guard on an already initialized
 * intercompany database.
 *
 * The complete transaction still verifies no receipt, payment, revision,
 * shared charge or cancellation before deleting anything.
 */
import type { Pool } from "pg";
import { logger } from "../../lib/logger";

const guardedLineLinkFunction = `
CREATE OR REPLACE FUNCTION public.ic_guard_trade_line_link()
RETURNS TRIGGER LANGUAGE plpgsql AS $block$
DECLARE trade_record RECORD;
DECLARE allowed_trade TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    allowed_trade := NULLIF(current_setting('erp.ic_physical_delete', true), '');
    IF TG_OP = 'DELETE' AND allowed_trade = OLD.trade_id::text
       AND EXISTS (
         SELECT 1 FROM public.intercompany_trades t
         JOIN public.containers c ON c.id=t.physical_container_id
         WHERE t.id=OLD.trade_id AND t.state='active' AND c.status='OTW'
           AND c.offload_date IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.intercompany_destination_receipts r WHERE r.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM public.intercompany_payment_allocations a WHERE a.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM public.intercompany_trade_revisions r WHERE r.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM public.intercompany_shared_charge_allocations a WHERE a.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM public.intercompany_shared_charge_po_allocations a WHERE a.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM public.intercompany_trade_cancellations c WHERE c.trade_id=t.id)
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Linked source/destination line identities are immutable';
  END IF;
  SELECT source_company_id, destination_company_id, original_supplier_po_id, destination_po_id
    INTO trade_record FROM public.intercompany_trades WHERE id=NEW.trade_id;
  IF NOT EXISTS (
    SELECT 1 FROM public.po_line_items src
      JOIN public.purchase_orders spo ON spo.id=src.po_id
      JOIN public.po_line_items dst ON dst.id=NEW.destination_line_id
      JOIN public.purchase_orders dpo ON dpo.id=dst.po_id
     WHERE src.id=NEW.source_line_id AND spo.company_id=trade_record.source_company_id
       AND dpo.company_id=trade_record.destination_company_id
       AND dpo.id=trade_record.destination_po_id
       AND spo.container_id=dpo.container_id
       AND (spo.id=trade_record.original_supplier_po_id OR EXISTS (
         SELECT 1 FROM public.intercompany_trade_source_pos t
         WHERE t.trade_id=NEW.trade_id AND t.source_po_id=spo.id
       ))
  ) THEN
    RAISE EXCEPTION 'Line links must connect the source and destination POs of one trade';
  END IF;
  RETURN NEW;
END $block$;
`;

export async function ensureLinkedPhysicalDeleteGuard(pool: Pool): Promise<void> {
  const found = await pool.query<{ implementation: string | null }>(`
    SELECT pg_get_functiondef(to_regprocedure('public.ic_guard_trade_line_link()')) AS implementation
  `);
  const existing = found.rows[0]?.implementation;
  // This feature must never create a trigger before the Phase 1-5 schema
  // exists. In normal production (main) the pre-existing version is unchanged.
  if (!existing) {
    throw new Error("IC_DELETE_SCHEMA_MISSING: install intercompany Phase 1-5 migrations first");
  }
  if (!existing.includes("erp.ic_physical_delete")) {
    await pool.query(guardedLineLinkFunction);
    logger.info("[startup] ✓ Intercompany linked-PO physical-delete trigger upgraded");
  }
  const verified = await pool.query<{ ready: boolean }>(`
    SELECT coalesce(
      position('erp.ic_physical_delete' in pg_get_functiondef(
        to_regprocedure('public.ic_guard_trade_line_link()')
      )) > 0,
      false
    ) AS ready
  `);
  if (verified.rows[0]?.ready !== true) {
    throw new Error("IC_DELETE_GUARD_NOT_INSTALLED");
  }
}
