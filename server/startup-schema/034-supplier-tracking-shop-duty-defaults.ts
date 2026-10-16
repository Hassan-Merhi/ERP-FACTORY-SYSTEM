/**
 * Supplier tracking defaults: free-text Shop Name and Duty Fee.
 * Keeps the original company/supplier mapping and historical container snapshots.
 * Replaces the stage 028 trigger function without dropping its existing trigger.
 */
export const supplierTrackingShopDutyDefaultsSchema: string[] = [
  `ALTER TABLE supplier_tracking_defaults ADD COLUMN IF NOT EXISTS shop_name text`,
  `ALTER TABLE supplier_tracking_defaults ADD COLUMN IF NOT EXISTS duty_fee numeric(15,2)`,
  `CREATE OR REPLACE FUNCTION apply_supplier_tracking_defaults_to_container()
    RETURNS trigger AS $$
    DECLARE
      default_shop text;
      default_agent varchar(100);
      default_duty numeric(15,2);
      old_default_shop text;
      old_default_agent varchar(100);
      old_default_duty numeric(15,2);
    BEGIN
      IF TG_OP = 'INSERT' THEN
        SELECT COALESCE(NULLIF(BTRIM(d.shop_name), ''), l.name),
               d.agent_name, d.duty_fee
          INTO default_shop, default_agent, default_duty
          FROM supplier_tracking_defaults d
          LEFT JOIN locations l
            ON l.id = d.location_id AND l.company_id = d.company_id
           AND l.active = true AND l.deleted_at IS NULL
         WHERE d.company_id = NEW.company_id
           AND d.supplier_id = NEW.supplier_id AND d.active = true
         LIMIT 1;

        IF COALESCE(BTRIM(NEW.shop_name), '') = ''
           AND COALESCE(BTRIM(default_shop), '') <> '' THEN
          NEW.shop_name := BTRIM(default_shop);
        END IF;
        IF COALESCE(BTRIM(NEW.agent), '') = ''
           AND COALESCE(BTRIM(default_agent), '') <> '' THEN
          NEW.agent := BTRIM(default_agent);
        END IF;
        -- Explicit 0 is a valid duty, not an empty value.
        IF NEW.duty_fee IS NULL AND default_duty IS NOT NULL THEN
          NEW.duty_fee := default_duty;
        END IF;

      ELSIF NEW.company_id IS DISTINCT FROM OLD.company_id
         OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
        SELECT COALESCE(NULLIF(BTRIM(d.shop_name), ''), l.name),
               d.agent_name, d.duty_fee
          INTO old_default_shop, old_default_agent, old_default_duty
          FROM supplier_tracking_defaults d
          LEFT JOIN locations l
            ON l.id = d.location_id AND l.company_id = d.company_id
           AND l.active = true AND l.deleted_at IS NULL
         WHERE d.company_id = OLD.company_id
           AND d.supplier_id = OLD.supplier_id AND d.active = true
         LIMIT 1;
        SELECT COALESCE(NULLIF(BTRIM(d.shop_name), ''), l.name),
               d.agent_name, d.duty_fee
          INTO default_shop, default_agent, default_duty
          FROM supplier_tracking_defaults d
          LEFT JOIN locations l
            ON l.id = d.location_id AND l.company_id = d.company_id
           AND l.active = true AND l.deleted_at IS NULL
         WHERE d.company_id = NEW.company_id
           AND d.supplier_id = NEW.supplier_id AND d.active = true
         LIMIT 1;

        IF COALESCE(BTRIM(NEW.shop_name), '') = ''
           OR (COALESCE(BTRIM(old_default_shop), '') <> ''
               AND BTRIM(NEW.shop_name) = BTRIM(old_default_shop)) THEN
          NEW.shop_name := NULLIF(BTRIM(default_shop), '');
        END IF;
        IF COALESCE(BTRIM(NEW.agent), '') = ''
           OR (COALESCE(BTRIM(old_default_agent), '') <> ''
               AND BTRIM(NEW.agent) = BTRIM(old_default_agent)) THEN
          NEW.agent := NULLIF(BTRIM(default_agent), '');
        END IF;
        IF NEW.duty_fee IS NULL
           OR (old_default_duty IS NOT NULL AND NEW.duty_fee = old_default_duty) THEN
          NEW.duty_fee := default_duty;
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`,
];
