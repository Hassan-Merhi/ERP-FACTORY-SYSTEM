import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { resolveDatabaseSsl } from "../server/lib/databaseSsl.mjs";
import { runTenantIsolationProbes } from "../server/schema/verifyDatabaseSchema.mjs";

/**
 * Company-scope RLS used to be applied at boot by server/companyScopeRlsBridge.mjs.
 * It is now part of the migrations, and startup only verifies it: the read-only
 * schema gate runs these tenant-isolation probes before anything else touches
 * data (preload order: tests/startup-preload-manifest.test.ts). Boot no longer
 * replays 0016 or takes its table locks.
 */
describe("company-scope RLS startup wiring", () => {
  it("verifies company-scope RLS fails closed against PostgreSQL", async () => {
    const connectionString = process.env.DATABASE_URL!;
    const client = new Client({ connectionString, ssl: resolveDatabaseSsl(connectionString) });
    await client.connect();
    try {
      await expect(runTenantIsolationProbes(client)).resolves.toEqual([]);
    } finally {
      await client.end();
    }
  });
});
