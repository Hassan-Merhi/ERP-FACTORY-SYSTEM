import assert from "node:assert/strict";
import test from "node:test";
import { makePostgresSubscriptionRepository } from "../server/services/commercial/postgresSubscriptionRepository.mjs";

function createPool({
  existing = {
    tenantId: "tenant_real_00001",
    provider: "paddle",
    plan: "business",
    status: "active",
    sequence: "1000",
  },
  failUpdate = false,
} = {}) {
  const statements = [];
  let released = 0;
  const client = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (sql.startsWith("SELECT account_id")) {
        return existing ? { rowCount: 1, rows: [existing] } : { rowCount: 0, rows: [] };
      }
      if (sql.startsWith("INSERT INTO commercial_subscription_events")) {
        return { rowCount: 1, rows: [{ id: 21 }] };
      }
      if (sql.startsWith("UPDATE commercial_subscriptions")) {
        return { rowCount: failUpdate ? 0 : 1, rows: [{ account_id: existing.tenantId }] };
      }
      if (sql.startsWith("UPDATE commercial_subscription_events")) {
        return { rowCount: 1, rows: [{ id: 21 }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {
      released++;
    },
  };
  return {
    pool: { connect: async () => client },
    statements,
    get released() {
      return released;
    },
  };
}

test("commercial subscription repository uses one transaction and explicit provider binding", async () => {
  const instance = createPool();
  const repo = makePostgresSubscriptionRepository(instance.pool);
  const result = await repo.transaction(async (tx) => {
    const current = await tx.lockSubscriptionByProviderId("paddle", "sub_abcdefgh123");
    assert.equal(current.tenantId, "tenant_real_00001");
    assert.equal(current.sequence, 1000);
    assert.equal(
      await tx.insertUniqueWebhookReceipt({
        provider: "paddle",
        eventId: "evt_abc123",
        tenantId: current.tenantId,
        eventType: "subscription.updated",
        occurredAtMs: 1794817920000,
        eventHash: "f".repeat(64),
      }),
      true
    );
    await tx.setSubscriptionState({
      provider: "paddle",
      providerSubscriptionId: "sub_abcdefgh123",
      tenantId: current.tenantId,
      plan: "business",
      status: "past_due",
      sequence: 1794817920000,
    });
    await tx.markWebhookReceipt("paddle", "evt_abc123", "processed");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(instance.statements[0].sql, "BEGIN");
  assert.equal(instance.statements.at(-1).sql, "COMMIT");
  assert.equal(instance.released, 1);
  assert.ok(instance.statements.some((x) => x.sql.includes("FOR UPDATE")));
  assert.ok(instance.statements.some((x) => x.sql.includes("ON CONFLICT (provider,provider_event_id) DO NOTHING")));
  assert.ok(instance.statements.every((x) => !x.sql.includes("tenant_attacker")));
});

test("conflicting update rolls back the event receipt and never commits", async () => {
  const instance = createPool({ failUpdate: true });
  const repo = makePostgresSubscriptionRepository(instance.pool);
  await assert.rejects(
    repo.transaction(async (tx) => {
      await tx.lockSubscriptionByProviderId("paddle", "sub_abcdefgh123");
      await tx.setSubscriptionState({
        provider: "paddle",
        providerSubscriptionId: "sub_abcdefgh123",
        tenantId: "tenant_real_00001",
        plan: "business",
        status: "active",
        sequence: 1794817920000,
      });
    }),
    /Concurrent subscription state conflict/
  );
  assert.equal(instance.statements.at(-1).sql, "ROLLBACK");
  assert.equal(instance.released, 1);
});

test("rejects missing pool and malformed event fingerprints", async () => {
  assert.throws(() => makePostgresSubscriptionRepository({}), /pool/i);
  const instance = createPool();
  await assert.rejects(
    makePostgresSubscriptionRepository(instance.pool).transaction((tx) =>
      tx.insertUniqueWebhookReceipt({
        provider: "paddle",
        eventId: "evt_invalid",
        tenantId: "tenant_real_00001",
        eventType: "subscription.updated",
        occurredAtMs: 1794817920000,
        eventHash: "not_sha256",
      })
    ),
    /SHA-256/
  );
  assert.equal(instance.statements.at(-1).sql, "ROLLBACK");
});
