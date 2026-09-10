/**
 * Supplier -> Shop/Location + Agent defaults for ERP container tracking.
 *
 * New containers receive blank Shop Name / Agent values from the selected
 * supplier's company-scoped mapping. If a container's supplier changes later,
 * values inherited from the previous supplier follow the new mapping while a
 * genuinely manual non-default value is preserved. Historical blank rows can be
 * populated explicitly from Settings via the backfill endpoint.
 */
export const supplierTrackingDefaultsSchema: string[] = [
  `CREATE TABLE IF NOT EXISTS supplier_tracking_defaults (
      id serial PRIMARY KEY,
      company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      supplier_id integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      location_id integer REFERENCES locations(id) ON DELETE SET NULL,
      agent_name varchar(100),
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS supplier_tracking_defaults_company_supplier_unique
     ON supplier_tracking_defaults (company_id, supplier_id)`,
  `CREATE INDEX IF NOT EXISTS supplier_tracking_defaults_company_idx
     ON supplier_tracking_defaults (company_id)`,
  `CREATE OR REPLACE FUNCTION apply_supplier_tracking_defaults_to_container()
    RETURNS trigger AS $$
    DECLARE
      default_shop text;
      default_agent varchar(100);
      old_default_shop text;
      old_default_agent varchar(100);
    BEGIN
      IF TG_OP = 'INSERT' THEN
        SELECT l.name, d.agent_name
          INTO default_shop, default_agent
          FROM supplier_tracking_defaults d
          LEFT JOIN locations l
            ON l.id = d.location_id
           AND l.company_id = d.company_id
           AND l.active = true
           AND l.deleted_at IS NULL
         WHERE d.company_id = NEW.company_id
           AND d.supplier_id = NEW.supplier_id
           AND d.active = true
         LIMIT 1;

        IF COALESCE(BTRIM(NEW.shop_name), '') = ''
           AND COALESCE(BTRIM(default_shop), '') <> '' THEN
          NEW.shop_name := BTRIM(default_shop);
        END IF;

        IF COALESCE(BTRIM(NEW.agent), '') = ''
           AND COALESCE(BTRIM(default_agent), '') <> '' THEN
          NEW.agent := BTRIM(default_agent);
        END IF;

      ELSIF NEW.company_id IS DISTINCT FROM OLD.company_id
         OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
        SELECT l.name, d.agent_name
          INTO old_default_shop, old_default_agent
          FROM supplier_tracking_defaults d
          LEFT JOIN locations l
            ON l.id = d.location_id
           AND l.company_id = d.company_id
           AND l.active = true
           AND l.deleted_at IS NULL
         WHERE d.company_id = OLD.company_id
           AND d.supplier_id = OLD.supplier_id
           AND d.active = true
         LIMIT 1;

        SELECT l.name, d.agent_name
          INTO default_shop, default_agent
          FROM supplier_tracking_defaults d
          LEFT JOIN locations l
            ON l.id = d.location_id
           AND l.company_id = d.company_id
           AND l.active = true
           AND l.deleted_at IS NULL
         WHERE d.company_id = NEW.company_id
           AND d.supplier_id = NEW.supplier_id
           AND d.active = true
         LIMIT 1;

        IF COALESCE(BTRIM(NEW.shop_name), '') = ''
           OR (
             COALESCE(BTRIM(old_default_shop), '') <> ''
             AND BTRIM(NEW.shop_name) = BTRIM(old_default_shop)
           ) THEN
          NEW.shop_name := NULLIF(BTRIM(default_shop), '');
        END IF;

        IF COALESCE(BTRIM(NEW.agent), '') = ''
           OR (
             COALESCE(BTRIM(old_default_agent), '') <> ''
             AND BTRIM(NEW.agent) = BTRIM(old_default_agent)
           ) THEN
          NEW.agent := NULLIF(BTRIM(default_agent), '');
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS containers_apply_supplier_tracking_defaults ON containers`,
  `CREATE TRIGGER containers_apply_supplier_tracking_defaults
     BEFORE INSERT OR UPDATE OF company_id, supplier_id ON containers
     FOR EACH ROW
     EXECUTE FUNCTION apply_supplier_tracking_defaults_to_container()`,
];
