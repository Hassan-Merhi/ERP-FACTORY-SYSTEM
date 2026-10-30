import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { ensureEdgeVoucherOutboxSchema } from "../server/edge/edgeVoucherOutbox";

const hasPostgres = Boolean(process.env.DATABASE_URL);
const testDatabase = hasPostgres ? describe : describe.skip;

testDatabase("Phase 4 LAN durable database outbox", () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
    connectionTimeoutMillis: 5000,
  });
  const siteId = randomUUID();
  const operationId = randomUUID();
  let schema = "";

  beforeAll(async () => {
    vi.stubEnv("FACTORY_EDGE_MODE", "lan");
    vi.stubEnv("FACTORY_EDGE_SITE_ID", siteId);
    vi.stubEnv("FACTORY_EDGE_HOSTNAME", "erp.factory.internal");
    vi.stubEnv("FACTORY_EDGE_WRITE_MODE", "read-only");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PGHOST", "postgres");
    vi.stubEnv("PGPORT", "5432");
    vi.stubEnv("PGUSER", "erp_edge");
    vi.stubEnv("PGPASSWORD", "unit-test-key-".repeat(6));
    vi.stubEnv("PGDATABASE", "erp_edge");
    vi.stubEnv("PGSSLMODE", "disable");
    vi.stubEnv("SESSION_SECRET", "unit-test-secret-".repeat(6));
    vi.stubEnv("CSRF_ENFORCE", "1");
    vi.stubEnv("ENABLE_SCHEDULERS", "false");
    vi.stubEnv("RUN_STARTUP_MIGRATIONS", "true");
    await client.connect();
    await client.query("BEGIN");
    schema = "edge_phase4_" + randomUUID().replaceAll("-", "");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await ensureEdgeVoucherOutboxSchema(client as never);
  });

  afterAll(async () => {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
    vi.unstubAllEnvs();
  });

  it("persists a unique site/operation pair and rejects duplicate local vouchers", async () => {
    const insert = `
      INSERT INTO factory_edge_voucher_outbox
        (sequence, site_id, operation_id, company_id, actor_user_id,
         local_voucher_id, payload, payload_sha256)
      VALUES (1, $1, $2, 20, 'operator', 10, '{"voucher":{"id":10},"entries":[]}'::jsonb, $3)
    `;
    await client.query(insert, [siteId, operationId, "a".repeat(64)]);
    const result = await client.query("SELECT count(*)::integer AS count FROM factory_edge_voucher_outbox");
    expect(result.rows[0].count).toBe(1);
    await client.query("SAVEPOINT duplicate_check");
    await expect(client.query(insert, [siteId, randomUUID(), "a".repeat(64)])).rejects.toMatchObject({
      code: "23505",
    });
    await client.query("ROLLBACK TO SAVEPOINT duplicate_check");
  });

  it("prevents source evidence from being updated or deleted", async () => {
    await client.query("SAVEPOINT immutable_update");
    await expect(
      client.query("UPDATE factory_edge_voucher_outbox SET payload_sha256 = $1", ["b".repeat(64)])
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT immutable_update");
    await client.query("SAVEPOINT immutable_delete");
    await expect(client.query("DELETE FROM factory_edge_voucher_outbox")).rejects.toMatchObject({
      code: "23514",
    });
    await client.query("ROLLBACK TO SAVEPOINT immutable_delete");
  });
});
