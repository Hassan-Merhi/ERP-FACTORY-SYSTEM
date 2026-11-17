INSERT INTO "user_security_permissions" ("user_id", "company_id", "permission", "granted_by")
SELECT ucr."user_id", ucr."company_id", 'factory.raw-stock.repair', ucr."user_id"
FROM "user_company_roles" ucr
WHERE ucr."role" IN ('Admin', 'Developer')
ON CONFLICT ("user_id", "company_id", "permission") DO NOTHING;
