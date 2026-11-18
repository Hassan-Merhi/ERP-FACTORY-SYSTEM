-- French Factory snapshot capture at document creation time only.
-- These BEFORE INSERT triggers fill missing French snapshots using the agreed
-- fallback chain: French -> English -> Arabic -> article code. No UPDATE trigger
-- exists, so later catalog edits cannot rewrite historical document text.
BEGIN;

CREATE OR REPLACE FUNCTION resolve_factory_product_french_snapshot(
  p_company_id integer,
  p_product_id integer,
  p_article_code text
) RETURNS TABLE(product_name_fr text, category_fr text)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(NULLIF(BTRIM(p.name_fr), ''), NULLIF(BTRIM(p.name), ''), NULLIF(BTRIM(p.name_ar), ''), NULLIF(BTRIM(p.article_code), '')),
    COALESCE(NULLIF(BTRIM(c.name_fr), ''), NULLIF(BTRIM(c.name), ''), NULLIF(BTRIM(c.name_ar), ''), NULLIF(BTRIM(p.article_code), ''))
  FROM factory_bale_products p
  LEFT JOIN factory_categories c
    ON c.id = p.category_id
   AND c.company_id = p.company_id
   AND c.deleted_at IS NULL
  WHERE p.company_id = p_company_id
    AND p.deleted_at IS NULL
    AND (
      (p_product_id IS NOT NULL AND p.id = p_product_id)
      OR (
        p_product_id IS NULL
        AND p_article_code IS NOT NULL
        AND UPPER(BTRIM(p.article_code)) = UPPER(BTRIM(p_article_code))
      )
    )
  ORDER BY CASE WHEN p.id = p_product_id THEN 0 ELSE 1 END
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION snapshot_factory_bales_french() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF NULLIF(BTRIM(NEW.product_name_fr), '') IS NULL OR NULLIF(BTRIM(NEW.category_fr), '') IS NULL THEN
    SELECT * INTO r FROM resolve_factory_product_french_snapshot(NEW.company_id, NEW.product_id, NEW.article_code);
    NEW.product_name_fr := COALESCE(NULLIF(BTRIM(NEW.product_name_fr), ''), r.product_name_fr, NULLIF(BTRIM(NEW.product_name), ''), NULLIF(BTRIM(NEW.article_code), ''));
    NEW.category_fr := COALESCE(NULLIF(BTRIM(NEW.category_fr), ''), r.category_fr, NULLIF(BTRIM(NEW.category), ''), NULLIF(BTRIM(NEW.article_code), ''));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_factory_bales_french_snapshot ON factory_bales;
CREATE TRIGGER trg_factory_bales_french_snapshot BEFORE INSERT ON factory_bales
FOR EACH ROW EXECUTE FUNCTION snapshot_factory_bales_french();

CREATE OR REPLACE FUNCTION snapshot_customer_proforma_lines_french() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record; company_id_value integer;
BEGIN
  IF NULLIF(BTRIM(NEW.product_name_fr), '') IS NULL THEN
    SELECT company_id INTO company_id_value FROM customer_proformas WHERE id = NEW.proforma_id;
    SELECT * INTO r FROM resolve_factory_product_french_snapshot(company_id_value, NULL, NEW.article_code);
    NEW.product_name_fr := COALESCE(r.product_name_fr, NULLIF(BTRIM(NEW.product_name), ''), NULLIF(BTRIM(NEW.article_code), ''));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_customer_proforma_lines_french_snapshot ON customer_proforma_lines;
CREATE TRIGGER trg_customer_proforma_lines_french_snapshot BEFORE INSERT ON customer_proforma_lines
FOR EACH ROW EXECUTE FUNCTION snapshot_customer_proforma_lines_french();

CREATE OR REPLACE FUNCTION snapshot_customer_order_lines_french() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record; company_id_value integer;
BEGIN
  IF NULLIF(BTRIM(NEW.bale_name_fr), '') IS NULL THEN
    SELECT company_id INTO company_id_value FROM customer_orders WHERE id = NEW.order_id;
    SELECT * INTO r FROM resolve_factory_product_french_snapshot(company_id_value, NULL, NEW.article_code);
    NEW.bale_name_fr := COALESCE(r.product_name_fr, NULLIF(BTRIM(NEW.bale_name), ''), NULLIF(BTRIM(NEW.article_code), ''));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_customer_order_lines_french_snapshot ON customer_order_lines;
CREATE TRIGGER trg_customer_order_lines_french_snapshot BEFORE INSERT ON customer_order_lines
FOR EACH ROW EXECUTE FUNCTION snapshot_customer_order_lines_french();

CREATE OR REPLACE FUNCTION snapshot_customer_order_bales_french() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record; company_id_value integer; product_id_value integer; article_code_value text;
BEGIN
  IF NULLIF(BTRIM(NEW.bale_name_fr), '') IS NULL THEN
    SELECT company_id INTO company_id_value FROM customer_orders WHERE id = NEW.order_id;
    SELECT product_id, article_code INTO product_id_value, article_code_value FROM factory_bales WHERE id = NEW.bale_id;
    SELECT * INTO r FROM resolve_factory_product_french_snapshot(company_id_value, product_id_value, COALESCE(NEW.article_code, article_code_value));
    NEW.bale_name_fr := COALESCE(r.product_name_fr, NULLIF(BTRIM(NEW.bale_name), ''), NULLIF(BTRIM(NEW.article_code), ''), NULLIF(BTRIM(article_code_value), ''));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_customer_order_bales_french_snapshot ON customer_order_bales;
CREATE TRIGGER trg_customer_order_bales_french_snapshot BEFORE INSERT ON customer_order_bales
FOR EACH ROW EXECUTE FUNCTION snapshot_customer_order_bales_french();
DROP TRIGGER IF EXISTS trg_customer_order_bales_history_french_snapshot ON customer_order_bales_history;
CREATE TRIGGER trg_customer_order_bales_history_french_snapshot BEFORE INSERT ON customer_order_bales_history
FOR EACH ROW EXECUTE FUNCTION snapshot_customer_order_bales_french();

CREATE OR REPLACE FUNCTION snapshot_customer_order_expected_lines_french() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF NULLIF(BTRIM(NEW.product_name_fr), '') IS NULL THEN
    SELECT * INTO r FROM resolve_factory_product_french_snapshot(NEW.company_id, NULL, NEW.article_code);
    NEW.product_name_fr := COALESCE(r.product_name_fr, NULLIF(BTRIM(NEW.product_name), ''), NULLIF(BTRIM(NEW.article_code), ''));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_customer_order_expected_lines_french_snapshot ON customer_order_expected_lines;
CREATE TRIGGER trg_customer_order_expected_lines_french_snapshot BEFORE INSERT ON customer_order_expected_lines
FOR EACH ROW EXECUTE FUNCTION snapshot_customer_order_expected_lines_french();

CREATE OR REPLACE FUNCTION snapshot_factory_pos_sale_items_french() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF NULLIF(BTRIM(NEW.product_name_fr), '') IS NULL THEN
    SELECT * INTO r FROM resolve_factory_product_french_snapshot(NEW.company_id, NEW.product_id, NEW.article_code);
    NEW.product_name_fr := COALESCE(r.product_name_fr, NULLIF(BTRIM(NEW.product_name), ''), NULLIF(BTRIM(NEW.article_code), ''));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_factory_pos_sale_items_french_snapshot ON factory_pos_sale_items;
CREATE TRIGGER trg_factory_pos_sale_items_french_snapshot BEFORE INSERT ON factory_pos_sale_items
FOR EACH ROW EXECUTE FUNCTION snapshot_factory_pos_sale_items_french();

CREATE OR REPLACE FUNCTION snapshot_order_related_product_french() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record; company_id_value integer; product_id_value integer; article_code_value text;
BEGIN
  IF NULLIF(BTRIM(NEW.product_name_fr), '') IS NULL THEN
    SELECT company_id INTO company_id_value FROM customer_orders WHERE id = NEW.order_id;
    SELECT product_id, article_code INTO product_id_value, article_code_value FROM factory_bales WHERE id = NEW.bale_id;
    SELECT * INTO r FROM resolve_factory_product_french_snapshot(company_id_value, product_id_value, COALESCE(NEW.article_code, article_code_value));
    NEW.product_name_fr := COALESCE(r.product_name_fr, NULLIF(BTRIM(NEW.product_name), ''), NULLIF(BTRIM(NEW.article_code), ''), NULLIF(BTRIM(article_code_value), ''));
  END IF;
  RETURN NEW;
END;
$$;
DO $$ BEGIN
  IF to_regclass('public.customer_order_bale_removals') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_customer_order_bale_removals_french_snapshot ON customer_order_bale_removals;
    CREATE TRIGGER trg_customer_order_bale_removals_french_snapshot BEFORE INSERT ON customer_order_bale_removals
    FOR EACH ROW EXECUTE FUNCTION snapshot_order_related_product_french();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION snapshot_factory_v3_load_bales_french() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record; company_id_value integer; product_id_value integer; article_code_value text;
BEGIN
  IF NULLIF(BTRIM(NEW.product_name_fr), '') IS NULL THEN
    SELECT company_id INTO company_id_value FROM factory_v3_loads WHERE id = NEW.load_id;
    SELECT product_id, article_code INTO product_id_value, article_code_value FROM factory_bales WHERE id = NEW.bale_id;
    SELECT * INTO r FROM resolve_factory_product_french_snapshot(company_id_value, product_id_value, COALESCE(NEW.article_code, article_code_value));
    NEW.product_name_fr := COALESCE(r.product_name_fr, NULLIF(BTRIM(NEW.product_name), ''), NULLIF(BTRIM(NEW.article_code), ''), NULLIF(BTRIM(article_code_value), ''));
  END IF;
  RETURN NEW;
END;
$$;
DO $$ BEGIN
  IF to_regclass('public.factory_v3_load_bales') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_factory_v3_load_bales_french_snapshot ON factory_v3_load_bales;
    CREATE TRIGGER trg_factory_v3_load_bales_french_snapshot BEFORE INSERT ON factory_v3_load_bales
    FOR EACH ROW EXECUTE FUNCTION snapshot_factory_v3_load_bales_french();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION snapshot_customer_dispatch_bale_scans_french() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record; product_id_value integer; article_code_value text;
BEGIN
  IF NULLIF(BTRIM(NEW.product_name_fr), '') IS NULL THEN
    SELECT product_id, article_code INTO product_id_value, article_code_value FROM factory_bales WHERE id = NEW.bale_id;
    SELECT * INTO r FROM resolve_factory_product_french_snapshot(NEW.company_id, product_id_value, COALESCE(NEW.article_code, article_code_value));
    NEW.product_name_fr := COALESCE(r.product_name_fr, NULLIF(BTRIM(NEW.product_name), ''), NULLIF(BTRIM(NEW.article_code), ''), NULLIF(BTRIM(article_code_value), ''));
  END IF;
  RETURN NEW;
END;
$$;
DO $$ BEGIN
  IF to_regclass('public.customer_dispatch_bale_scans') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_customer_dispatch_bale_scans_french_snapshot ON customer_dispatch_bale_scans;
    CREATE TRIGGER trg_customer_dispatch_bale_scans_french_snapshot BEFORE INSERT ON customer_dispatch_bale_scans
    FOR EACH ROW EXECUTE FUNCTION snapshot_customer_dispatch_bale_scans_french();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION snapshot_bale_recode_items_french() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record; company_id_value integer;
BEGIN
  IF NULLIF(BTRIM(NEW.product_name_fr), '') IS NULL THEN
    SELECT company_id INTO company_id_value FROM bale_recode_sessions WHERE id = NEW.session_id;
    SELECT * INTO r FROM resolve_factory_product_french_snapshot(company_id_value, NEW.product_id, NEW.article_code);
    NEW.product_name_fr := COALESCE(r.product_name_fr, NULLIF(BTRIM(NEW.product_name), ''), NULLIF(BTRIM(NEW.article_code), ''));
  END IF;
  RETURN NEW;
END;
$$;
DO $$ BEGIN
  IF to_regclass('public.bale_recode_items') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_bale_recode_items_french_snapshot ON bale_recode_items;
    CREATE TRIGGER trg_bale_recode_items_french_snapshot BEFORE INSERT ON bale_recode_items
    FOR EACH ROW EXECUTE FUNCTION snapshot_bale_recode_items_french();
  END IF;
END $$;

COMMIT;
