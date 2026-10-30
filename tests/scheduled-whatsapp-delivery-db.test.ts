/**
 * Scheduled WhatsApp delivery leases against PostgreSQL: claiming an
 * occurrence, sending its attachments, recording failures and uncertain
 * uploads, and recovering a retryable occurrence. Each case runs in a
 * rolled-back transaction that every pool call is routed to.
 */
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../server/lib/logger";
import {
  beginScheduledWhatsAppAttachmentAttempt,
  claimRetryableScheduledWhatsAppOccurrence,
  claimScheduledWhatsAppOccurrence,
  finalizeScheduledWhatsAppOccurrence,
  finishScheduledWhatsAppAttachmentAttempt,
  logScheduledWhatsAppAttachmentResult,
  recordScheduledWhatsAppAttachmentPreparationFailure,
  recordScheduledWhatsAppAttachmentUncertain,
  type ScheduledWhatsAppClaim,
} from "../server/services/scheduler/scheduledWhatsAppDelivery";
import { withRolledBackPool } from "./helpers/routedPoolClient";

let seq = 0;

function occurrence(over: Record<string, unknown> = {}) {
  return {
    jobType: "stock_report",
    companyId: null,
    recipientKey: `group:${process.pid}-${++seq}@g.us`,
    recipientChatId: "120@g.us",
    scheduledLocalDate: "2026-10-20",
    scheduledLocalHour: 9,
    attachmentKeys: ["pdf", "xlsx", "pdf"],
    ...over,
  };
}

async function attachments(client: PoolClient, claim: ScheduledWhatsAppClaim) {
  return (
    await client.query(
      `SELECT attachment_key AS key, status, attempt_count, last_error, sent_at IS NOT NULL AS sent
         FROM scheduled_whatsapp_attachments WHERE occurrence_id = $1 ORDER BY id`,
      [claim.id]
    )
  ).rows;
}

async function occurrenceRow(client: PoolClient, claim: ScheduledWhatsAppClaim) {
  return (
    await client.query(
      `SELECT status, claim_token, last_error, completed_at IS NOT NULL AS completed,
              delivery_started_at IS NOT NULL AS started, claim_expires_at > now() AS leased
         FROM scheduled_whatsapp_occurrences WHERE id = $1`,
      [claim.id]
    )
  ).rows[0];
}

const expireLease = (client: PoolClient, claim: ScheduledWhatsAppClaim) =>
  client.query(
    "UPDATE scheduled_whatsapp_occurrences SET claim_expires_at = now() - interval '1 minute' WHERE id = $1",
    [claim.id]
  );

beforeEach(() => {
  vi.spyOn(logger, "info").mockImplementation(() => logger);
  vi.spyOn(logger, "error").mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduled WhatsApp delivery", () => {
  it("claims an occurrence once and delivers every attachment", async () => {
    await withRolledBackPool(async (client) => {
      const input = occurrence({ companyId: null });
      const claim = await claimScheduledWhatsAppOccurrence(input);
      expect(claim).toMatchObject({
        acquired: true,
        status: "claimed",
        recipientChatId: "120@g.us",
        scheduledLocalDate: "2026-10-20",
        scheduledLocalHour: 9,
        occurrenceKey: `stock_report:global:${input.recipientKey}:2026-10-20:09`,
      });
      expect(claim?.claimToken).toMatch(/^[0-9a-f-]{36}$/);
      expect(claim?.attachments.map((a) => [a.key, a.status, a.attemptCount])).toEqual([
        ["pdf", "pending", 0],
        ["xlsx", "pending", 0],
      ]);

      // A second worker sees the live lease and does not acquire it.
      const second = await claimScheduledWhatsAppOccurrence(input);
      expect(second).toMatchObject({ id: claim!.id, acquired: false, status: "claimed" });

      expect(await beginScheduledWhatsAppAttachmentAttempt(claim!, "pdf")).toBe(1);
      expect(await occurrenceRow(client, claim!)).toMatchObject({ status: "delivering", started: true });
      // Already sending: a second start is refused.
      expect(await beginScheduledWhatsAppAttachmentAttempt(claim!, "pdf")).toBeNull();
      await finishScheduledWhatsAppAttachmentAttempt({ claim: claim!, attachmentKey: "pdf", success: true });
      expect(await beginScheduledWhatsAppAttachmentAttempt(claim!, "xlsx")).toBe(1);
      await finishScheduledWhatsAppAttachmentAttempt({
        claim: claim!,
        attachmentKey: "xlsx",
        success: true,
        error: null,
      });

      await expect(finalizeScheduledWhatsAppOccurrence(claim!)).resolves.toEqual({
        allSent: true,
        status: "sent",
        error: null,
      });
      expect(await occurrenceRow(client, claim!)).toMatchObject({ status: "sent", claim_token: null, completed: true });
      expect(await attachments(client, claim!)).toEqual([
        { key: "pdf", status: "sent", attempt_count: 1, last_error: null, sent: true },
        { key: "xlsx", status: "sent", attempt_count: 1, last_error: null, sent: true },
      ]);

      // A sent occurrence is never claimed again.
      await expireLease(client, claim!);
      await expect(claimScheduledWhatsAppOccurrence(input)).resolves.toMatchObject({ acquired: false, status: "sent" });
      await expect(
        claimRetryableScheduledWhatsAppOccurrence({
          jobType: input.jobType,
          recipientKey: input.recipientKey,
          recipientChatId: input.recipientChatId,
        })
      ).resolves.toBeNull();
      expect(logger.info).toHaveBeenCalledWith(
        "[ScheduledWhatsApp] occurrence claimed",
        expect.objectContaining({ result: "claimed", recipient: input.recipientKey })
      );
    });
  });

  it("only reads an existing occurrence when creation is not allowed", async () => {
    await withRolledBackPool(async (client) => {
      const companyId = Number(
        (
          await client.query("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [
            `SWD${process.pid}${++seq}`,
            "SWD",
          ])
        ).rows[0].id
      );
      const input = occurrence({ companyId });
      await expect(claimScheduledWhatsAppOccurrence(input, { allowCreate: false })).resolves.toBeNull();
      const claim = await claimScheduledWhatsAppOccurrence(input);
      expect(claim?.occurrenceKey).toContain(`:company-${companyId}:`);
      await expect(claimScheduledWhatsAppOccurrence(input, { allowCreate: false })).resolves.toMatchObject({
        id: claim!.id,
        acquired: false,
      });
    });
  });

  it("marks a partial delivery and lets a retry resume only what failed", async () => {
    await withRolledBackPool(async (client) => {
      const input = occurrence();
      const claim = (await claimScheduledWhatsAppOccurrence(input))!;
      await beginScheduledWhatsAppAttachmentAttempt(claim, "pdf");
      await finishScheduledWhatsAppAttachmentAttempt({ claim, attachmentKey: "pdf", success: true });
      expect(
        await recordScheduledWhatsAppAttachmentPreparationFailure({
          claim,
          attachmentKey: "xlsx",
          error: new Error("x".repeat(2100)),
        })
      ).toBe(1);

      const result = await finalizeScheduledWhatsAppOccurrence(claim);
      expect(result).toMatchObject({ allSent: false, status: "partial" });
      expect(result.error).toHaveLength(2000);
      expect(await occurrenceRow(client, claim)).toMatchObject({ status: "partial", claim_token: null });

      const retryInput = {
        jobType: input.jobType,
        recipientKey: input.recipientKey,
        recipientChatId: input.recipientChatId,
      };
      await expect(claimRetryableScheduledWhatsAppOccurrence({ ...retryInput, companyId: 3 })).resolves.toBeNull();
      await expect(
        claimRetryableScheduledWhatsAppOccurrence({ ...retryInput, recipientChatId: "other@g.us" })
      ).resolves.toBeNull();
      const retry = await claimRetryableScheduledWhatsAppOccurrence(retryInput);
      expect(retry).toMatchObject({ id: claim.id, acquired: true, status: "claimed" });
      expect(retry!.claimToken).not.toBe(claim.claimToken);
      expect(retry!.attachments.map((a) => [a.key, a.status, a.attemptCount])).toEqual([
        ["pdf", "sent", 1],
        ["xlsx", "failed", 1],
      ]);
      expect(retry!.attachments[0].sentAt).toBeInstanceOf(Date);
      expect(logger.info).toHaveBeenCalledWith(
        "[ScheduledWhatsApp] retry occurrence claimed",
        expect.objectContaining({ result: "retry_claimed" })
      );

      // The old lease token no longer controls the occurrence.
      expect(await beginScheduledWhatsAppAttachmentAttempt(claim, "xlsx")).toBeNull();
      expect(await beginScheduledWhatsAppAttachmentAttempt(retry!, "pdf")).toBeNull();
      expect(await beginScheduledWhatsAppAttachmentAttempt(retry!, "xlsx")).toBe(2);
      await finishScheduledWhatsAppAttachmentAttempt({
        claim: retry!,
        attachmentKey: "xlsx",
        success: false,
        error: "Green API 500",
      });
      await expect(finalizeScheduledWhatsAppOccurrence(retry!)).resolves.toEqual({
        allSent: false,
        status: "partial",
        error: "Green API 500",
      });
    });
  });

  it("fails an occurrence where nothing was sent", async () => {
    await withRolledBackPool(async (client) => {
      const claim = (await claimScheduledWhatsAppOccurrence(occurrence({ attachmentKeys: ["pdf"] })))!;
      expect(
        await recordScheduledWhatsAppAttachmentPreparationFailure({ claim, attachmentKey: "pdf", error: "" })
      ).toBe(1);
      // An empty error still gets the shared "unexpected error" text.
      expect((await attachments(client, claim))[0]).toMatchObject({
        status: "failed",
        last_error: "Unexpected server error",
      });
      await expect(finalizeScheduledWhatsAppOccurrence(claim)).resolves.toMatchObject({
        allSent: false,
        status: "failed",
      });

      // Without a live lease nothing can be recorded.
      expect(
        await recordScheduledWhatsAppAttachmentPreparationFailure({
          claim: { ...claim, acquired: false },
          attachmentKey: "pdf",
          error: "x",
        })
      ).toBeNull();
      expect(
        await recordScheduledWhatsAppAttachmentPreparationFailure({
          claim: { ...claim, claimToken: null },
          attachmentKey: "pdf",
          error: "x",
        })
      ).toBeNull();
      expect(
        await recordScheduledWhatsAppAttachmentPreparationFailure({ claim, attachmentKey: "pdf", error: "x" })
      ).toBeNull();
      expect(await beginScheduledWhatsAppAttachmentAttempt({ ...claim, acquired: false }, "pdf")).toBeNull();
      expect(await beginScheduledWhatsAppAttachmentAttempt({ ...claim, claimToken: null }, "pdf")).toBeNull();

      // A lease that has run out no longer authorises writes.
      const expired = (await claimScheduledWhatsAppOccurrence(occurrence({ attachmentKeys: ["pdf"] })))!;
      await expireLease(client, expired);
      expect(await beginScheduledWhatsAppAttachmentAttempt(expired, "pdf")).toBeNull();
      expect(
        await recordScheduledWhatsAppAttachmentPreparationFailure({ claim: expired, attachmentKey: "pdf", error: "x" })
      ).toBeNull();
    });
  });

  it("keeps an uncertain upload blocked from automatic recovery", async () => {
    await withRolledBackPool(async (client) => {
      const input = occurrence({ attachmentKeys: ["pdf"] });
      const claim = (await claimScheduledWhatsAppOccurrence(input))!;
      await beginScheduledWhatsAppAttachmentAttempt(claim, "pdf");
      await recordScheduledWhatsAppAttachmentUncertain({
        claim,
        attachmentKey: "pdf",
        error: new Error("socket hang up"),
      });
      expect((await attachments(client, claim))[0]).toMatchObject({ status: "sending", last_error: "socket hang up" });
      expect(await occurrenceRow(client, claim)).toMatchObject({ last_error: "socket hang up" });

      await expect(finalizeScheduledWhatsAppOccurrence(claim)).resolves.toMatchObject({
        status: "delivering",
        allSent: false,
      });
      // The lease is kept while an upload is in doubt.
      expect(await occurrenceRow(client, claim)).toMatchObject({ status: "delivering", claim_token: claim.claimToken });

      await expireLease(client, claim);
      const retryInput = {
        jobType: input.jobType,
        recipientKey: input.recipientKey,
        recipientChatId: input.recipientChatId,
      };
      await expect(claimRetryableScheduledWhatsAppOccurrence(retryInput)).resolves.toBeNull();
      await expect(claimScheduledWhatsAppOccurrence(input)).resolves.toMatchObject({
        acquired: false,
        status: "delivering",
      });

      // Uncertain without a lease is ignored.
      await recordScheduledWhatsAppAttachmentUncertain({
        claim: { ...claim, acquired: false },
        attachmentKey: "pdf",
        error: "x",
      });
      await recordScheduledWhatsAppAttachmentUncertain({ claim, attachmentKey: "pdf", error: "" });
      expect((await attachments(client, claim))[0].last_error).toBe("Unexpected server error");
    });
  });

  it("recovers abandoned claims and expired deliveries", async () => {
    await withRolledBackPool(async (client) => {
      const input = occurrence({ attachmentKeys: ["pdf"] });
      const abandoned = (await claimScheduledWhatsAppOccurrence(input))!;
      // Claimed but never started, lease expired: another worker may take it.
      await expireLease(client, abandoned);
      const takeover = await claimScheduledWhatsAppOccurrence(input);
      expect(takeover).toMatchObject({ acquired: true, status: "claimed" });
      expect(takeover!.claimToken).not.toBe(abandoned.claimToken);

      // Delivering with nothing left in "sending" and an expired lease is retryable.
      await beginScheduledWhatsAppAttachmentAttempt(takeover!, "pdf");
      await finishScheduledWhatsAppAttachmentAttempt({
        claim: takeover!,
        attachmentKey: "pdf",
        success: false,
        error: "boom",
      });
      expect(await occurrenceRow(client, takeover!)).toMatchObject({ status: "delivering", leased: true });
      const retryInput = {
        jobType: input.jobType,
        recipientKey: input.recipientKey,
        recipientChatId: input.recipientChatId,
      };
      await expect(claimRetryableScheduledWhatsAppOccurrence(retryInput)).resolves.toBeNull();
      await expireLease(client, takeover!);
      // A scheduled tick never takes over a delivery; only the retry path does.
      await expect(claimScheduledWhatsAppOccurrence(input)).resolves.toMatchObject({
        acquired: false,
        status: "delivering",
      });
      const resumed = await claimRetryableScheduledWhatsAppOccurrence(retryInput);
      expect(resumed).toMatchObject({ acquired: true, status: "claimed" });

      // A worker that dies after re-claiming a started delivery, before it
      // sends anything, leaves a recoverable claim once the lease expires.
      await expect(claimRetryableScheduledWhatsAppOccurrence(retryInput)).resolves.toBeNull();
      await expireLease(client, resumed!);
      const recovered = await claimRetryableScheduledWhatsAppOccurrence(retryInput);
      expect(recovered).toMatchObject({ id: resumed!.id, acquired: true, status: "claimed" });
      expect(recovered!.claimToken).not.toBe(resumed!.claimToken);

      // Anything older than the 36-hour retry window is left alone.
      const stale = (await claimScheduledWhatsAppOccurrence(occurrence({ attachmentKeys: ["pdf"] })))!;
      await client.query(
        "UPDATE scheduled_whatsapp_occurrences SET status='failed', claim_token=NULL, created_at = now() - interval '37 hours' WHERE id=$1",
        [stale.id]
      );
      const staleKey = (
        await client.query("SELECT recipient_key FROM scheduled_whatsapp_occurrences WHERE id=$1", [stale.id])
      ).rows[0].recipient_key;
      await expect(
        claimRetryableScheduledWhatsAppOccurrence({
          jobType: "stock_report",
          recipientKey: staleKey,
          recipientChatId: "120@g.us",
        })
      ).resolves.toBeNull();
    });
  });

  it("logs each attachment result at the right level", async () => {
    const claim = { occurrenceKey: "k" } as ScheduledWhatsAppClaim;
    await logScheduledWhatsAppAttachmentResult({ claim, recipient: "r", attachment: "pdf", attempt: 2, success: true });
    expect(logger.info).toHaveBeenCalledWith("[ScheduledWhatsApp] attachment result", {
      occurrenceKey: "k",
      recipient: "r",
      attachment: "pdf",
      attempt: 2,
      result: "sent",
      error: undefined,
    });
    await logScheduledWhatsAppAttachmentResult({
      claim,
      recipient: "r",
      attachment: "pdf",
      attempt: 3,
      success: false,
      error: new Error("Green API 500"),
    });
    expect(logger.error).toHaveBeenCalledWith(
      "[ScheduledWhatsApp] attachment result",
      expect.objectContaining({ result: "failed", error: "Green API 500" })
    );
  });
});
