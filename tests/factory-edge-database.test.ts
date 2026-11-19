import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

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
  // Unique per run: the outbox key is the global sequence.
  const firstSequence = 9_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000);

  // The table, its unique keys and its append-only trigger come from migrations/.
  // Everything below runs in one transaction that is rolled back.
  beforeAll(async () => {
    await client.connect();
    await client.query("BEGIN");
  });

  afterAll(async () => {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  });

  it("persists a unique site/operation pair and rejects duplicate local vouchers", async () => {
    const insert = `
      INSERT INTO factory_edge_voucher_outbox
        (sequence, site_id, operation_id, company_id, actor_user_id,
         local_voucher_id, payload, payload_sha256)
      VALUES ($4, $1, $2, 20, 'operator', 10, '{"voucher":{"id":10},"entries":[]}'::jsonb, $3)
    `;
    await client.query(insert, [siteId, operationId, "a".repeat(64), firstSequence]);
    const result = await client.query(
      "SELECT count(*)::integer AS count FROM factory_edge_voucher_outbox WHERE site_id = $1",
      [siteId]
    );
    expect(result.rows[0].count).toBe(1);
    await client.query("SAVEPOINT duplicate_check");
    await expect(client.query(insert, [siteId, randomUUID(), "a".repeat(64), firstSequence + 1])).rejects.toMatchObject(
      {
        code: "23505",
      }
    );
    await client.query("ROLLBACK TO SAVEPOINT duplicate_check");
  });

  it("prevents source evidence from being updated or deleted", async () => {
    await client.query("SAVEPOINT immutable_update");
    await expect(
      client.query("UPDATE factory_edge_voucher_outbox SET payload_sha256 = $1 WHERE site_id = $2", [
        "b".repeat(64),
        siteId,
      ])
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT immutable_update");
    await client.query("SAVEPOINT immutable_delete");
    await expect(
      client.query("DELETE FROM factory_edge_voucher_outbox WHERE site_id = $1", [siteId])
    ).rejects.toMatchObject({
      code: "23514",
    });
    await client.query("ROLLBACK TO SAVEPOINT immutable_delete");
  });
});
