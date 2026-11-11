/**
 * Boot-time repair for the Phase 4 TablePlus guard after dispatch accounting.
 * Production may disable bulk migrations. This only replaces the existing
 * guard function when its matching trigger is already installed; it neither
 * creates accounting tables nor changes orders, bales, or posted vouchers.
 */
import type { Pool } from "pg";

export async function ensureDispatchLoadingBaleScanGuard(pool: Pick<Pool, "query">): Promise<void> {
  const existing = await pool.query<{ installed: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'customer_order_bales'
        AND t.tgname = 'factory_dispatch_order_bale_financial_guard'
        AND NOT t.tgisinternal
        AND t.tgfoid = to_regprocedure('public.factory_dispatch_guard_order_bale_evidence()')
    ) AS installed
  `);
  if (existing.rows[0]?.installed !== true) return;

  // CREATE OR REPLACE preserves the trigger, grants, and all posted bale locks.
  // New inserts are allowed only while the parent remains an unfinished loading.
  await pool.query(`
    CREATE OR REPLACE FUNCTION factory_dispatch_guard_order_bale_evidence()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE
      old_company_id INTEGER;
      order_status TEXT;
      order_invoice_number TEXT;
      has_live BOOLEAN;
      is_posted_bale BOOLEAN;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        SELECT company_id, status, invoice_number
          INTO old_company_id, order_status, order_invoice_number
          FROM customer_orders WHERE id = NEW.order_id;
        IF old_company_id IS NULL THEN RETURN NEW; END IF;
        -- Financially completed orders remain immutable. Earlier POSTED trucks do
        -- not lock future additions to an unfinished loading; existing posted
        -- bales, their prices, and their truck evidence are still guarded below.
        SELECT EXISTS(
          SELECT 1 FROM factory_dispatch_trip_financials
           WHERE company_id=old_company_id AND order_id=NEW.order_id
             AND status = 'CONSOLIDATED'
        ) INTO has_live;
        IF has_live THEN
          RAISE EXCEPTION 'Cannot add bales after the dispatch invoice is consolidated';
        END IF;
        SELECT EXISTS(
          SELECT 1 FROM factory_dispatch_trip_financials
           WHERE company_id=old_company_id AND order_id=NEW.order_id
             AND status = 'POSTED'
        ) INTO has_live;
        IF has_live AND (
          order_status NOT IN ('DRAFT', 'LOADING', 'PENDING_VERIFICATION')
          OR order_invoice_number IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'Cannot add bales to a completed dispatch loading';
        END IF;
        RETURN NEW;
      END IF;
    
      SELECT company_id INTO old_company_id FROM customer_orders WHERE id = OLD.order_id;
      IF old_company_id IS NULL THEN RETURN OLD; END IF;
      SELECT EXISTS(
        SELECT 1 FROM factory_dispatch_trip_financials
         WHERE company_id=old_company_id AND order_id=OLD.order_id
           AND status IN ('POSTED','CONSOLIDATED')
      ) INTO has_live;
      IF NOT has_live THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END IF;
      SELECT EXISTS (
        SELECT 1 FROM factory_dispatch_trip_financial_bales b
          JOIN factory_dispatch_trip_financials f
            ON f.id=b.financial_id AND f.company_id=b.company_id
           AND f.order_id=b.order_id AND f.dispatch_id=b.dispatch_id
         WHERE b.company_id=old_company_id AND b.order_id=OLD.order_id
           AND b.bale_id=OLD.bale_id AND b.snapshot_revision=f.snapshot_revision
           AND f.status IN ('POSTED','CONSOLIDATED')
      ) INTO is_posted_bale;
    
      IF TG_OP = 'UPDATE' THEN
        -- No silent valuation or identity changes while trip balances exist;
        -- only the later approved consolidation procedure can remove the hold.
        RAISE EXCEPTION 'Loading bale records are locked while dispatch trips have live financial postings';
      END IF;
      IF is_posted_bale THEN
        RAISE EXCEPTION 'Financially posted dispatch bale cannot be removed from Pending Loading';
      END IF;
      -- Unshipped/unscanned bale removals remain possible through the authorized
      -- reconciliation endpoint, which checks status and approver on the server.
      RETURN OLD;
    END;
    $$;
  `);
}
