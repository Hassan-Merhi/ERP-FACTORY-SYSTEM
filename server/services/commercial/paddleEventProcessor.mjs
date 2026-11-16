import { createHash } from "node:crypto";
import { applySubscriptionEvent } from "./subscriptionPolicy.mjs";
import { parseVerifiedPaddleSubscription } from "./paddleVerification.mjs";

/**
 * Handle a verified Paddle subscription notification with transactional
 * persistence injected by the storage implementation.
 *
 * Storage must implement atomic locking + INSERT ... ON CONFLICT for
 * provider_event_id and compare event occurrence sequence to the previously
 * committed subscription. This function deliberately never trusts custom_data
 * or email for tenant resolution.
 *
 * No HTTP registration, payment charges, or production database effects.
 */
export async function processPaddleSubscriptionNotification({ rawBody, signature, secret, nowMs, repository }) {
  if (!repository || typeof repository.transaction !== "function") {
    throw new TypeError("Transactional subscription repository required");
  }
  const verified = parseVerifiedPaddleSubscription({
    rawBody,
    signature,
    secret,
    nowMs,
  });
  return repository.transaction(async (tx) => {
    if (
      typeof tx.lockSubscriptionByProviderId !== "function" ||
      typeof tx.insertUniqueWebhookReceipt !== "function" ||
      typeof tx.setSubscriptionState !== "function" ||
      typeof tx.markWebhookReceipt !== "function"
    ) {
      throw new TypeError("Incomplete transaction repository");
    }
    // A trusted pre-existing mapping is the only account lookup authority.
    const current = await tx.lockSubscriptionByProviderId("paddle", verified.providerSubscriptionId);
    if (!current || !current.tenantId || current.provider !== "paddle") {
      return { processed: false, reason: "unknown_subscription" };
    }
    const receiptInserted = await tx.insertUniqueWebhookReceipt({
      provider: "paddle",
      eventId: verified.eventId,
      tenantId: current.tenantId,
      eventType: verified.eventType,
      occurredAtMs: verified.occurredAtMs,
      eventHash: createHash("sha256").update(rawBody).digest("hex"),
    });
    if (!receiptInserted) {
      return { processed: false, reason: "duplicate_event" };
    }
    const state = applySubscriptionEvent(
      {
        tenantId: current.tenantId,
        status: current.status,
        plan: current.plan,
        sequence: current.sequence,
      },
      {
        tenantId: current.tenantId,
        eventId: verified.eventId,
        sequence: verified.occurredAtMs,
        status: verified.status,
        plan: current.plan,
      }
    );
    if (state.ignored) {
      await tx.markWebhookReceipt("paddle", verified.eventId, "ignored");
      return { processed: false, reason: state.reason };
    }
    await tx.setSubscriptionState({
      ...state,
      provider: "paddle",
      providerSubscriptionId: verified.providerSubscriptionId,
    });
    await tx.markWebhookReceipt("paddle", verified.eventId, "processed");
    return { processed: true, reason: "updated" };
  });
}
