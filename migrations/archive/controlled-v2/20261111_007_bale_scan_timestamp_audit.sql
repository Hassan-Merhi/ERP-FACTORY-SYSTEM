-- Extract the exact bale scan timestamp/history schema from the existing startup bridge.
-- Creates missing objects only and preserves all existing scan records.
-- This migration is explicit/controlled; no automatic startup execution.
DO $preflight$
BEGIN
 IF to_regclass('public.customer_order_bales') IS NULL THEN
  RAISE EXCEPTION 'Live customer_order_bales required before scan audit migration';
 END IF;
END
$preflight$;

ALTER TABLE public.customer_order_bales ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.customer_order_bales_history (
          id serial PRIMARY KEY,
          original_id integer NOT NULL,
          order_id integer NOT NULL,
          bale_id integer NOT NULL,
          bale_reference varchar(100) NOT NULL,
          location_id integer NOT NULL,
          weight decimal(15,3) NOT NULL,
          article_code varchar(50),
          bale_name text,
          price_used decimal(20,2) NOT NULL,
          scanned_by text,
          scanned_at timestamptz,
          cancelled_at timestamptz NOT NULL DEFAULT now()
        );
ALTER TABLE public.customer_order_bales_history ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.set_customer_order_bale_scanned_at()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        restored_at TIMESTAMPTZ;
        restored_match BOOLEAN := FALSE;
        history_has_scanned_at BOOLEAN := FALSE;
      BEGIN
        IF NEW.scanned_at IS NOT NULL THEN
          RETURN NEW;
        END IF;

        IF to_regclass('public.customer_order_bales_history') IS NOT NULL THEN
          SELECT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'customer_order_bales_history'
              AND column_name = 'scanned_at'
          ) INTO history_has_scanned_at;

          IF history_has_scanned_at THEN
            SELECT h.scanned_at, TRUE
            INTO restored_at, restored_match
            FROM public.customer_order_bales_history h
            WHERE h.order_id = NEW.order_id
              AND h.bale_id = NEW.bale_id
            ORDER BY h.cancelled_at DESC
            LIMIT 1;

            IF restored_match THEN
              NEW.scanned_at := restored_at;
              RETURN NEW;
            END IF;
          END IF;
        END IF;

        IF NEW.scanned_by IS NOT NULL AND btrim(NEW.scanned_by) <> '' THEN
          NEW.scanned_at := CURRENT_TIMESTAMP;
        END IF;
        RETURN NEW;
      END;
      $$;

DO $triggers$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.customer_order_bales'::regclass
   AND tgname='customer_order_bales_set_scanned_at' AND NOT tgisinternal) THEN
  CREATE TRIGGER customer_order_bales_set_scanned_at
        BEFORE INSERT ON public.customer_order_bales
        FOR EACH ROW
        EXECUTE FUNCTION public.set_customer_order_bale_scanned_at();
 END IF;
END
$triggers$;

CREATE OR REPLACE FUNCTION public.copy_customer_order_bale_scanned_at_to_history()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.scanned_at IS NULL THEN
            SELECT cob.scanned_at
            INTO NEW.scanned_at
            FROM public.customer_order_bales cob
            WHERE cob.id = NEW.original_id
            LIMIT 1;
          END IF;
          RETURN NEW;
        END;
        $$;

DO $triggers$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.customer_order_bales_history'::regclass
   AND tgname='customer_order_bales_history_copy_scanned_at' AND NOT tgisinternal) THEN
  CREATE TRIGGER customer_order_bales_history_copy_scanned_at
          BEFORE INSERT ON public.customer_order_bales_history
          FOR EACH ROW
          EXECUTE FUNCTION public.copy_customer_order_bale_scanned_at_to_history();
 END IF;
END
$triggers$;
