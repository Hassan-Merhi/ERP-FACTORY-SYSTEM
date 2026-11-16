import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { processPaddleSubscriptionNotification } from "../server/services/commercial/paddleEventProcessor.mjs";

const secret = "sec_0123456789abcdef_0123456789";
const nowMs = Date.parse("2026-11-16T08:32:00Z");

const event = (overrides = {}) => ({
  event_id: "evt_abcdefgh123",
  event_type: "subscription.updated",
  occurred_at: "2026-11-16T08:32:00.000Z",
  data: {
    id: "sub_abcdefgh123",
    status: "past_due",
    custom_data: { accountId: "tenant_attacker_0001" },
  },
  ...overrides,
});

function signed(input) {
  const rawBody = JSON.stringify(input);
  const timestamp = String(Math.trunc(nowMs / 1000));
  const hmac = createHmac("sha256", secret).update(timestamp + ":" + rawBody).digest("hex");
  return { rawBody, signature: "ts=" + timestamp + ";h1=" + hmac, secret, nowMs };
}

function fakeRepository(initial = {}) {
  const receipts = new Set();
  const db = {
    tenantId: "tenant_real_00001",
    provider: "paddle",
    plan: "business",
    status: "active",
    sequence: 1000,
    ...initial,
  };
  return {
    db,
    receipts,
    transaction: async (fn) => fn({
      lockSubscriptionByProviderId: async (provider, id) =>
        provider === "paddle" && id === "sub_abcdefgh123" ? { ...db } : null,
      insertUniqueWebhookReceipt: async ({ provider, eventId }) => {
        const key = provider + ":" + eventId;
        if (receipts.has(key)) return false;
        receipts.add(key);
        return true;
      },
      setSubscriptionState: async (newState) => Object.assign(db, newState),
      markWebhookReceipt: async (provider, eventId, status) => {
        assert.equal(provider, "paddle");
        assert.ok(receipts.has(provider + ":" + eventId));
        assert.ok(["ignored", "processed"].includes(status));
      },
    }),
  };
}

test("verified provider event updates only pre-associated customer account", async () => {
  const repository = fakeRepository();
  const params = signed(event());
  const result = await processPaddleSubscriptionNotification({ ...params, repository });
  assert.deepEqual(result, { processed: true, reason: "updated" });
  assert.equal(repository.db.tenantId, "tenant_real_00001");
  assert.equal(repository.db.status, "past_due");
  assert.equal(repository.db.provider, "paddle");
  assert.notEqual(repository.db.tenantId, "tenant_attacker_0001");
});

test("provider event replay is ignored without a second mutation", async () => {
  const repository = fakeRepository();
  const params = signed(event());
  await processPaddleSubscriptionNotification({ ...params, repository });
  const before = { ...repository.db };
  const result = await processPaddleSubscriptionNotification({ ...params, repository });
  assert.deepEqual(result, { processed: false, reason: "duplicate_event" });
  assert.deepEqual(repository.db, before);
});

test("out-of-order provider events cannot reactivate an account", async () => {
  const repository = fakeRepository({ status: "past_due", sequence: nowMs + 1000 });
  const result = await processPaddleSubscriptionNotification({
    ...signed(event({ data: { id: "sub_abcdefgh123", status: "active" } })),
    repository,
  });
  assert.deepEqual(result, { processed: false, reason: "stale_sequence" });
  assert.equal(repository.db.status, "past_due");
});

test("unmapped subscriptions never create a customer account", async () => {
  const repository = fakeRepository();
  const result = await processPaddleSubscriptionNotification({
    ...signed(event({ data: { id: "sub_unknown123", status: "active" } })),
    repository,
  });
  assert.deepEqual(result, { processed: false, reason: "unknown_subscription" });
  assert.equal(repository.receipts.size, 0);
});

test("bad signatures and absent transactions fail closed", async () => {
  const repository = fakeRepository();
  await assert.rejects(
    processPaddleSubscriptionNotification({
      ...signed(event()),
      signature: "ts=1111111111;h1=bad",
      repository,
    }),
    /Unauthenticated/,
  );
  await assert.rejects(
    processPaddleSubscriptionNotification({ ...signed(event()), repository: {} }),
    /Transactional/,
  );
});
