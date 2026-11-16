-- Program 3C: database tenant safeguards for authentication and POS control tables.
--
-- Safety design:
--   * Foreign keys are NOT VALID: existing rows are not scanned or rewritten.
--   * NOT VALID foreign keys still protect new inserts and updates.
--   * Triggers enforce same-company references for new/changed control rows.
--   * Parent-update triggers prevent referenced locations/accounts from being moved
--     to a different company and silently invalidating control rows.
--   * No historical repair, DELETE, UPDATE, or backfill is performed here.
--
-- Before applying, run:
--   node scripts/tenant-control-integrity-audit.mjs --json
--
-- Apply only through the explicit Program 4 versioned migration runner after a
-- reviewed backup and owner approval.

CREATE INDEX IF NOT EXISTS user_company_roles_user_company_idx
  ON user_company_roles (user_id, company_id);

CREATE INDEX IF NOT EXISTS user_locations_user_company_idx
  ON user_locations (user_id, company_id);

CREATE INDEX IF NOT EXISTS role_feature_permissions_company_idx
  ON role_feature_permissions (company_id);

DO $tenant_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_company_roles_user_fk'
  ) THEN
    ALTER TABLE user_company_roles
      ADD CONSTRAINT user_company_roles_user_fk
      FOREIGN KEY (user_id) REFERENCES users(id)
      ON DELETE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_company_roles_company_fk'
  ) THEN
    ALTER TABLE user_company_roles
      ADD CONSTRAINT user_company_roles_company_fk
      FOREIGN KEY (company_id) REFERENCES companies(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_locations_user_fk'
  ) THEN
    ALTER TABLE user_locations
      ADD CONSTRAINT user_locations_user_fk
      FOREIGN KEY (user_id) REFERENCES users(id)
      ON DELETE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_locations_company_fk'
  ) THEN
    ALTER TABLE user_locations
      ADD CONSTRAINT user_locations_company_fk
      FOREIGN KEY (company_id) REFERENCES companies(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_location_cash_accounts_user_fk'
  ) THEN
    ALTER TABLE user_location_cash_accounts
      ADD CONSTRAINT user_location_cash_accounts_user_fk
      FOREIGN KEY (user_id) REFERENCES users(id)
      ON DELETE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_location_cash_accounts_company_fk'
  ) THEN
    ALTER TABLE user_location_cash_accounts
      ADD CONSTRAINT user_location_cash_accounts_company_fk
      FOREIGN KEY (company_id) REFERENCES companies(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'role_feature_permissions_company_fk'
  ) THEN
    ALTER TABLE role_feature_permissions
      ADD CONSTRAINT role_feature_permissions_company_fk
      FOREIGN KEY (company_id) REFERENCES companies(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_security_permissions_company_fk'
  ) THEN
    ALTER TABLE user_security_permissions
      ADD CONSTRAINT user_security_permissions_company_fk
      FOREIGN KEY (company_id) REFERENCES companies(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
END
$tenant_fk$;

CREATE OR REPLACE FUNCTION enforce_tenant_control_child_company()
RETURNS trigger
LANGUAGE plpgsql
AS $tenant_child$
DECLARE
  referenced_company_id integer;
BEGIN
  IF TG_TABLE_NAME = 'user_company_roles' THEN
    IF NEW.assigned_location_id IS NOT NULL THEN
      SELECT company_id INTO referenced_company_id
      FROM locations
      WHERE id = NEW.assigned_location_id;

      IF referenced_company_id IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23503',
          MESSAGE = 'assigned location does not exist';
      END IF;
      IF referenced_company_id <> NEW.company_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'assigned location belongs to another company';
      END IF;
    END IF;

    IF NEW.cash_account_id IS NOT NULL THEN
      SELECT company_id INTO referenced_company_id
      FROM ledger_accounts
      WHERE id = NEW.cash_account_id;

      IF referenced_company_id IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23503',
          MESSAGE = 'cash account does not exist';
      END IF;
      IF referenced_company_id <> NEW.company_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'cash account belongs to another company';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'user_locations' THEN
    SELECT company_id INTO referenced_company_id
    FROM locations
    WHERE id = NEW.location_id;

    IF referenced_company_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'assigned location does not exist';
    END IF;
    IF referenced_company_id <> NEW.company_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'user location belongs to another company';
    END IF;

  ELSIF TG_TABLE_NAME = 'user_location_cash_accounts' THEN
    SELECT company_id INTO referenced_company_id
    FROM locations
    WHERE id = NEW.location_id;

    IF referenced_company_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'POS location does not exist';
    END IF;
    IF referenced_company_id <> NEW.company_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'POS location belongs to another company';
    END IF;

    SELECT company_id INTO referenced_company_id
    FROM ledger_accounts
    WHERE id = NEW.cash_account_id;

    IF referenced_company_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'POS cash account does not exist';
    END IF;
    IF referenced_company_id <> NEW.company_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'POS cash account belongs to another company';
    END IF;
  END IF;

  RETURN NEW;
END
$tenant_child$;

DROP TRIGGER IF EXISTS user_company_roles_tenant_guard ON user_company_roles;
CREATE TRIGGER user_company_roles_tenant_guard
BEFORE INSERT OR UPDATE OF company_id, assigned_location_id, cash_account_id
ON user_company_roles
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_control_child_company();

DROP TRIGGER IF EXISTS user_locations_tenant_guard ON user_locations;
CREATE TRIGGER user_locations_tenant_guard
BEFORE INSERT OR UPDATE OF company_id, location_id
ON user_locations
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_control_child_company();

DROP TRIGGER IF EXISTS user_location_cash_accounts_tenant_guard ON user_location_cash_accounts;
CREATE TRIGGER user_location_cash_accounts_tenant_guard
BEFORE INSERT OR UPDATE OF company_id, location_id, cash_account_id
ON user_location_cash_accounts
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_control_child_company();

CREATE OR REPLACE FUNCTION prevent_tenant_control_parent_company_move()
RETURNS trigger
LANGUAGE plpgsql
AS $tenant_parent$
BEGIN
  IF NEW.company_id = OLD.company_id THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'locations' THEN
    IF EXISTS (
      SELECT 1 FROM user_company_roles
      WHERE assigned_location_id = OLD.id AND company_id <> NEW.company_id
    ) OR EXISTS (
      SELECT 1 FROM user_locations
      WHERE location_id = OLD.id AND company_id <> NEW.company_id
    ) OR EXISTS (
      SELECT 1 FROM user_location_cash_accounts
      WHERE location_id = OLD.id AND company_id <> NEW.company_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'location company cannot change while tenant control rows reference it';
    END IF;

  ELSIF TG_TABLE_NAME = 'ledger_accounts' THEN
    IF EXISTS (
      SELECT 1 FROM user_company_roles
      WHERE cash_account_id = OLD.id AND company_id <> NEW.company_id
    ) OR EXISTS (
      SELECT 1 FROM user_location_cash_accounts
      WHERE cash_account_id = OLD.id AND company_id <> NEW.company_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ledger account company cannot change while POS control rows reference it';
    END IF;
  END IF;

  RETURN NEW;
END
$tenant_parent$;

DROP TRIGGER IF EXISTS locations_tenant_control_parent_guard ON locations;
CREATE TRIGGER locations_tenant_control_parent_guard
BEFORE UPDATE OF company_id ON locations
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_control_parent_company_move();

DROP TRIGGER IF EXISTS ledger_accounts_tenant_control_parent_guard ON ledger_accounts;
CREATE TRIGGER ledger_accounts_tenant_control_parent_guard
BEFORE UPDATE OF company_id ON ledger_accounts
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_control_parent_company_move();
