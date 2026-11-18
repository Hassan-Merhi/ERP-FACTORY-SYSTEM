CREATE TABLE IF NOT EXISTS "user_security_permissions" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "company_id" integer NOT NULL,
  "permission" text NOT NULL,
  "granted_by" varchar REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_security_permissions_unique"
  ON "user_security_permissions" ("user_id", "company_id", "permission");

CREATE INDEX IF NOT EXISTS "user_security_permissions_company_user_idx"
  ON "user_security_permissions" ("company_id", "user_id");

INSERT INTO "user_security_permissions" ("user_id", "company_id", "permission", "granted_by")
SELECT ucr."user_id", ucr."company_id", permission_name, NULL
FROM "user_company_roles" ucr
CROSS JOIN (VALUES
  ('administration.repair'),
  ('security.permissions.manage'),
  ('security.anomalies.read')
) AS permissions(permission_name)
WHERE ucr."role" IN ('Admin', 'Developer')
ON CONFLICT ("user_id", "company_id", "permission") DO NOTHING;
