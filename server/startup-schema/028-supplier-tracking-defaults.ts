/**
 * Supplier -> Shop/Location + Agent defaults for ERP container tracking.
 *
 * Defaults are snapshots: a new container (or a placeholder whose supplier is
 * assigned later) receives blank Shop Name / Agent values from this mapping.
 * Existing non-blank tracking values are never overwritten. Historical rows can
 * be populated explicitly from Settings via the backfill endpoint.
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
      should_apply boolean := false;
      default_shop text;
      default_agent varchar(100);
    BEGIN
      IF TG_OP = 'INSERT' THEN
        should_apply := true;
      ELSIF NEW.company_id IS DISTINCT FROM OLD.company_id
         OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
        should_apply := true;
      END IF;

      IF should_apply THEN
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
