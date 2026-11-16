CREATE TABLE IF NOT EXISTS "user_credential_versions" (
  "user_id" varchar PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "credential_version" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

INSERT INTO "user_credential_versions" ("user_id", "credential_version")
SELECT "id", 0 FROM "users"
ON CONFLICT ("user_id") DO NOTHING;

CREATE OR REPLACE FUNCTION ensure_user_credential_version()
RETURNS trigger AS $$
BEGIN
  INSERT INTO user_credential_versions(user_id, credential_version, updated_at)
  VALUES (NEW.id, 0, now())
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_credential_version_insert ON users;
CREATE TRIGGER users_credential_version_insert
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION ensure_user_credential_version();

CREATE OR REPLACE FUNCTION rotate_user_credential_version()
RETURNS trigger AS $$
BEGIN
  IF NEW.password IS DISTINCT FROM OLD.password THEN
    INSERT INTO user_credential_versions(user_id, credential_version, updated_at)
    VALUES (NEW.id, 1, now())
    ON CONFLICT (user_id) DO UPDATE
      SET credential_version = user_credential_versions.credential_version + 1,
          updated_at = now();

    IF to_regclass('public.session') IS NOT NULL THEN
      EXECUTE 'DELETE FROM session WHERE sess->>''userId'' = $1' USING NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_credential_version_update ON users;
CREATE TRIGGER users_credential_version_update
AFTER UPDATE OF password ON users
FOR EACH ROW EXECUTE FUNCTION rotate_user_credential_version();
