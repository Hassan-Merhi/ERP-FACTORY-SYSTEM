import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseSsl } from "../server/lib/databaseSsl.mjs";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const roleName = "wave_g_rls_probe_role";
const probeTable = "wave_g_rls_probe";

async function setProbeScope(
  client: Client,
  scope: { maintenance?: "on" | "off"; companyId?: string; authorizedCompanyIds?: string }
) {
  await client.query(
    `SELECT
       set_config('app.company_scope_maintenance', $1, false),
       set_config('app.current_company_id', $2, false),
       set_config('app.authorized_company_ids', $3, false)`,
    [scope.maintenance ?? "off", scope.companyId ?? "", scope.authorizedCompanyIds ?? ""]
  );
}

describeDatabase("company-scope RLS runtime", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl, ssl: resolveDatabaseSsl(databaseUrl) });
    await client.connect();

    // The database is built from migrations/ (company-scope RLS is part of the
    // baseline); this suite probes the installed functions and policies.
    await client.query(`DROP TABLE IF EXISTS ${probeTable}`);
    await client.query(`DROP OWNED BY ${roleName}`).catch(() => {});
    await client.query(`DROP ROLE IF EXISTS ${roleName}`);
    await client.query(`CREATE ROLE ${roleName} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await client.query(
      `CREATE TABLE ${probeTable} (id serial PRIMARY KEY, company_id integer NOT NULL, marker text NOT NULL)`
    );
    await client.query(`ALTER TABLE ${probeTable} ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${probeTable} FORCE ROW LEVEL SECURITY`);
    await client.query(`CREATE POLICY ${probeTable}_company_scope_policy ON ${probeTable}
      USING (erp_company_scope_matches(company_id))
      WITH CHECK (erp_company_scope_matches(company_id))`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${probeTable} TO ${roleName}`);
    await client.query(`GRANT USAGE, SELECT ON SEQUENCE ${probeTable}_id_seq TO ${roleName}`);
    await client.query(`INSERT INTO ${probeTable} (company_id, marker) VALUES (101, 'company-a'), (202, 'company-b')`);
    // Make the non-superuser probe the table owner. FORCE RLS must still apply;
    // without FORCE, PostgreSQL table owners bypass ordinary row security.
    await client.query(`ALTER TABLE ${probeTable} OWNER TO ${roleName}`);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("RESET ROLE").catch(() => {});
    await client.query(`DROP TABLE IF EXISTS ${probeTable}`).catch(() => {});
    await client.query(`DROP OWNED BY ${roleName}`).catch(() => {});
    await client.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {});
    await client.end();
  });

  it("installs and forces RLS with the expected policies on every present protected table", async () => {
    const protectedTables = [
      "vouchers",
      "customers",
      "ledger_accounts",
      "bank_accounts",
      "fixed_assets",
      "stock_groups",
      "stock_items",
      "inventory",
      "voucher_entries",
    ];
    const result = await client.query(
      `SELECT c.relname AS table_name,
              c.relrowsecurity AS rls_enabled,
              c.relforcerowsecurity AS rls_forced,
              EXISTS (
                SELECT 1 FROM pg_policies p
                WHERE p.schemaname = 'public'
                  AND p.tablename = c.relname
                  AND p.policyname = CASE
                    WHEN c.relname = 'voucher_entries' THEN 'voucher_entries_company_scope_policy'
                    ELSE c.relname || '_company_scope_policy'
                  END
              ) AS policy_present
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [protectedTables]
    );

    expect(result.rows.map((row) => row.table_name).sort()).toEqual([...protectedTables].sort());
    for (const row of result.rows) {
      expect(row.rls_enabled, `${row.table_name} should have RLS enabled`).toBe(true);
      expect(row.rls_forced, `${row.table_name} should force RLS for its owner`).toBe(true);
      expect(row.policy_present, `${row.table_name} should have a company policy`).toBe(true);
    }
  });

  it("fails closed when no tenant or maintenance scope is asserted", async () => {
    await client.query(`SET ROLE ${roleName}`);
    await setProbeScope(client, { companyId: "" });
    await expect(client.query(`SELECT marker FROM ${probeTable} ORDER BY marker`)).rejects.toMatchObject({
      code: "22023",
    });
    await client.query("RESET ROLE");
  });

  it("allows explicit process-owned maintenance scope without inventing a tenant", async () => {
    await client.query(`SET ROLE ${roleName}`);
    await setProbeScope(client, { maintenance: "on" });
    const result = await client.query(`SELECT marker FROM ${probeTable} ORDER BY marker`);
    expect(result.rows.map((row) => row.marker)).toEqual(["company-a", "company-b"]);
    await client.query("RESET ROLE");
  });

  it("isolates the table owner and rejects cross-company writes when tenant context is asserted", async () => {
    await client.query(`SET ROLE ${roleName}`);
    const identity = await client.query(
      `SELECT current_user, pg_get_userbyid(c.relowner) AS owner, c.relforcerowsecurity AS forced
       FROM pg_class c WHERE c.relname = $1`,
      [probeTable]
    );
    expect(identity.rows[0]).toMatchObject({ current_user: roleName, owner: roleName, forced: true });

    await setProbeScope(client, { companyId: "101" });
    const result = await client.query(`SELECT marker FROM ${probeTable} ORDER BY marker`);
    expect(result.rows.map((row) => row.marker)).toEqual(["company-a"]);
    await expect(
      client.query(`INSERT INTO ${probeTable} (company_id, marker) VALUES (202, 'blocked')`)
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("RESET ROLE");
  });

  it("supports only explicitly asserted secondary company ids for intentional intercompany work", async () => {
    await client.query(`SET ROLE ${roleName}`);
    await setProbeScope(client, { companyId: "101", authorizedCompanyIds: "202" });
    const result = await client.query(`SELECT marker FROM ${probeTable} ORDER BY marker`);
    expect(result.rows.map((row) => row.marker)).toEqual(["company-a", "company-b"]);
    await client.query("RESET ROLE");
  });

  it("fails closed for malformed, non-positive, and malformed-secondary tenant assertions", async () => {
    await client.query(`SET ROLE ${roleName}`);
    await setProbeScope(client, { companyId: "garbage" });
    await expect(client.query(`SELECT marker FROM ${probeTable}`)).rejects.toMatchObject({ code: "22P02" });

    await setProbeScope(client, { companyId: "0" });
    await expect(client.query(`SELECT marker FROM ${probeTable}`)).rejects.toMatchObject({ code: "22023" });

    await setProbeScope(client, { companyId: "101", authorizedCompanyIds: "202,garbage" });
    await expect(client.query("SELECT erp_authorized_company_ids()")).rejects.toMatchObject({ code: "22023" });
    await client.query("RESET ROLE");
  });

  it("does not leak transaction-local company scope after commit", async () => {
    await setProbeScope(client, { companyId: "" });
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_company_id', '101', true)");
    expect((await client.query("SELECT erp_current_company_id() AS company_id")).rows[0].company_id).toBe(101);
    await client.query("COMMIT");
    expect(
      (await client.query("SELECT nullif(current_setting('app.current_company_id', true), '') AS company_id")).rows[0]
        .company_id
    ).toBeNull();
    await expect(client.query("SELECT erp_current_company_id() AS company_id")).rejects.toMatchObject({
      code: "22023",
    });
  });
});
