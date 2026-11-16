import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  verifyPaddleSignature,
  parseVerifiedPaddleSubscription,
} from "../server/services/commercial/paddleVerification.mjs";

const secret = "sec_0123456789abcdef_0123456789";
const nowMs = Date.parse("2026-11-16T08:32:00Z");
const ts = String(Math.trunc(nowMs / 1000));
const signed = (payload, timestamp = ts) => {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = createHmac("sha256", secret)
    .update(timestamp + ":" + body)
    .digest("hex");
  return { rawBody: body, signature: `ts=${timestamp};h1=${signature}`, secret, nowMs };
};
test("verifier accepts only exact signed bytes with current timestamp", () => {
  const good = signed('{"hello":"world"}');
  assert.equal(verifyPaddleSignature(good), true);
  assert.equal(verifyPaddleSignature({ ...good, rawBody: '{"hello":"world"} ' }), false);
  assert.equal(verifyPaddleSignature({ ...good, secret: "wrong" }), false);
  assert.equal(verifyPaddleSignature({ ...good, signature: "ts=abc;h1=abcdef" }), false);
  assert.equal(verifyPaddleSignature({ ...good, signature: good.signature.replace("h1=", "h1=00") }), false);
  assert.equal(verifyPaddleSignature({ ...good, nowMs: nowMs + 6000 }), false);
  assert.equal(verifyPaddleSignature({ ...good, nowMs: nowMs - 6000 }), false);
  assert.equal(
    verifyPaddleSignature({ ...good, signature: good.signature + ";h1=" + good.signature.split("h1=")[1] }),
    true
  );
});
test("verified subscription parses only expected event types and identifiers", () => {
  const base = {
    event_id: "evt_abcdefgh123",
    event_type: "subscription.updated",
    occurred_at: "2026-11-16T08:32:00Z",
    data: { id: "sub_abcdefgh123", status: "active", custom_data: { accountId: "tenant_fake" } },
  };
  const parsed = parseVerifiedPaddleSubscription(signed(base));
  assert.equal(parsed.provider, "paddle");
  assert.equal(parsed.status, "active");
  assert.equal(parsed.providerSubscriptionId, "sub_abcdefgh123");
  assert.equal(Object.hasOwn(parsed, "accountId"), false, "do not trust client-supplied metadata as tenant identity");
  assert.throws(
    () => parseVerifiedPaddleSubscription(signed({ ...base, event_type: "transaction.created" })),
    /Not a subscription/
  );
  assert.throws(
    () => parseVerifiedPaddleSubscription(signed({ ...base, data: { id: "sub_abcdefgh123", status: "unknown" } })),
    /Unsupported/
  );
  assert.throws(
    () => parseVerifiedPaddleSubscription({ ...signed(base), signature: "ts=123;h1=00" }),
    /Unauthenticated/
  );
});
