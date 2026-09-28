import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";

export type ScheduledWhatsAppOccurrenceStatus =
  | "claimed"
  | "delivering"
  | "partial"
  | "failed"
  | "sent";

export type ScheduledWhatsAppAttachmentStatus = "pending" | "sending" | "failed" | "sent";

export interface ScheduledWhatsAppOccurrenceInput {
  jobType: string;
  companyId?: number | null;
  recipientKey: string;
  recipientChatId: string;
  scheduledLocalDate: string;
  scheduledLocalHour: number;
  attachmentKeys: string[];
}

export interface ScheduledWhatsAppAttachmentState {
  key: string;
  status: ScheduledWhatsAppAttachmentStatus;
  attemptCount: number;
  lastError: string | null;
  sentAt: Date | null;
}

export interface ScheduledWhatsAppClaim {
  id: number;
  occurrenceKey: string;
  acquired: boolean;
  status: ScheduledWhatsAppOccurrenceStatus;
  recipientChatId: string;
  scheduledLocalDate: string;
  scheduledLocalHour: number;
  claimToken: string | null;
  attachments: ScheduledWhatsAppAttachmentState[];
}

const CLAIM_LEASE_MINUTES = 15;
const RETRY_LOOKBACK_HOURS = 36;

function normalizeKeyPart(value: string): string {
  return value.trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_.:@-]/g, "_");
}

export function buildScheduledWhatsAppOccurrenceKey(input: {
  jobType: string;
  companyId?: number | null;
  recipientKey: string;
  scheduledLocalDate: string;
  scheduledLocalHour: number;
}): string {
  return [
    normalizeKeyPart(input.jobType),
    input.companyId == null ? "global" : `company-${input.companyId}`,
    normalizeKeyPart(input.recipientKey),
    input.scheduledLocalDate,
    String(input.scheduledLocalHour).padStart(2, "0"),
  ].join(":");
}

async function loadAttachments(client: PoolClient, occurrenceId: number): Promise<ScheduledWhatsAppAttachmentState[]> {
  const result = await client.query<{
    attachment_key: string;
    status: ScheduledWhatsAppAttachmentStatus;
    attempt_count: number;
    last_error: string | null;
    sent_at: Date | null;
  }>(
    `SELECT attachment_key, status, attempt_count, last_error, sent_at
       FROM scheduled_whatsapp_attachments
      WHERE occurrence_id = $1
      ORDER BY id`,
    [occurrenceId]
  );
  return result.rows.map((row) => ({
    key: row.attachment_key,
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    lastError: row.last_error,
    sentAt: row.sent_at ? new Date(row.sent_at) : null,
  }));
}

async function loadClaim(
  client: PoolClient,
  row: {
    id: string | number;
    occurrence_key: string;
    status: ScheduledWhatsAppOccurrenceStatus;
    recipient_chat_id: string;
    scheduled_local_date: string | Date;
    scheduled_local_hour: number;
    claim_token: string | null;
  },
  acquired: boolean
): Promise<ScheduledWhatsAppClaim> {
  return {
    id: Number(row.id),
    occurrenceKey: row.occurrence_key,
    acquired,
    status: row.status,
    recipientChatId: row.recipient_chat_id,
    scheduledLocalDate:
      typeof row.scheduled_local_date === "string"
        ? row.scheduled_local_date.slice(0, 10)
        : row.scheduled_local_date.toISOString().slice(0, 10),
    scheduledLocalHour: Number(row.scheduled_local_hour),
    claimToken: row.claim_token,
    attachments: await loadAttachments(client, Number(row.id)),
  };
}

async function acquireExistingOccurrence(
  client: PoolClient,
  occurrenceId: number,
  claimToken: string
): Promise<boolean> {
  const result = await client.query(
    `UPDATE scheduled_whatsapp_occurrences o
        SET claim_token = $2,
            claim_expires_at = now() + interval '${CLAIM_LEASE_MINUTES} minutes',
            status = 'claimed',
            last_error = NULL,
            updated_at = now()
      WHERE o.id = $1
        AND (
          (
            o.status IN ('partial', 'failed')
            AND (o.claim_token IS NULL OR o.claim_expires_at < now())
          )
          OR (
            o.status = 'claimed'
            AND o.delivery_started_at IS NULL
            AND o.claim_expires_at < now()
          )
          OR (
            o.status = 'delivering'
            AND o.claim_expires_at < now()
          )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM scheduled_whatsapp_attachments a
           WHERE a.occurrence_id = o.id
             AND a.status = 'sending'
        )
      RETURNING o.id`,
    [occurrenceId, claimToken]
  );
  return Boolean(result.rowCount);
}

export async function claimScheduledWhatsAppOccurrence(
  input: ScheduledWhatsAppOccurrenceInput,
  options: { allowCreate?: boolean } = {}
): Promise<ScheduledWhatsAppClaim | null> {
  const allowCreate = options.allowCreate !== false;
  const occurrenceKey = buildScheduledWhatsAppOccurrenceKey(input);
  const claimToken = randomUUID();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let occurrence = await client.query<{
      id: string | number;
      occurrence_key: string;
      status: ScheduledWhatsAppOccurrenceStatus;
      recipient_chat_id: string;
      scheduled_local_date: string | Date;
      scheduled_local_hour: number;
      claim_token: string | null;
    }>(
      `SELECT id, occurrence_key, status, recipient_chat_id, scheduled_local_date, scheduled_local_hour, claim_token
         FROM scheduled_whatsapp_occurrences
        WHERE occurrence_key = $1
        FOR UPDATE`,
      [occurrenceKey]
    );

    if (!occurrence.rows.length && allowCreate) {
      occurrence = await client.query(
        `INSERT INTO scheduled_whatsapp_occurrences (
            job_type, company_id, recipient_key, recipient_chat_id,
            scheduled_local_date, scheduled_local_hour, occurrence_key,
            status, claim_token, claim_expires_at
          ) VALUES ($1,$2,$3,$4,$5::date,$6,$7,'claimed',$8,now() + interval '${CLAIM_LEASE_MINUTES} minutes')
          ON CONFLICT (occurrence_key) DO NOTHING
          RETURNING id, occurrence_key, status, recipient_chat_id, scheduled_local_date, scheduled_local_hour, claim_token`,
        [
          input.jobType,
          input.companyId ?? null,
          input.recipientKey,
          input.recipientChatId,
          input.scheduledLocalDate,
          input.scheduledLocalHour,
          occurrenceKey,
          claimToken,
        ]
      );

      if (occurrence.rows.length) {
        const occurrenceId = Number(occurrence.rows[0].id);
        for (const attachmentKey of [...new Set(input.attachmentKeys)]) {
          await client.query(
            `INSERT INTO scheduled_whatsapp_attachments (occurrence_id, attachment_key, status)
             VALUES ($1,$2,'pending')
             ON CONFLICT (occurrence_id, attachment_key) DO NOTHING`,
            [occurrenceId, attachmentKey]
          );
        }
        const claim = await loadClaim(client, occurrence.rows[0], true);
        await client.query("COMMIT");
        logger.info("[ScheduledWhatsApp] occurrence claimed", {
          jobType: input.jobType,
          occurrenceKey,
          recipient: input.recipientKey,
          result: "claimed",
        });
        return claim;
      }

      occurrence = await client.query(
        `SELECT id, occurrence_key, status, recipient_chat_id, scheduled_local_date, scheduled_local_hour, claim_token
           FROM scheduled_whatsapp_occurrences
          WHERE occurrence_key = $1
          FOR UPDATE`,
        [occurrenceKey]
      );
    }

    if (!occurrence.rows.length) {
      await client.query("COMMIT");
      return null;
    }

    const row = occurrence.rows[0];
    let acquired = false;
    if (row.status !== "sent" && row.status !== "delivering") {
      acquired = await acquireExistingOccurrence(client, Number(row.id), claimToken);
      if (acquired) {
        row.status = "claimed";
        row.claim_token = claimToken;
      }
    }

    const claim = await loadClaim(client, row, acquired);
    await client.query("COMMIT");
    return claim;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function claimRetryableScheduledWhatsAppOccurrence(input: {
  jobType: string;
  companyId?: number | null;
  recipientKey: string;
  recipientChatId: string;
}): Promise<ScheduledWhatsAppClaim | null> {
  const claimToken = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const candidate = await client.query<{
      id: string | number;
      occurrence_key: string;
      status: ScheduledWhatsAppOccurrenceStatus;
      recipient_chat_id: string;
      scheduled_local_date: string | Date;
      scheduled_local_hour: number;
      claim_token: string | null;
    }>(
      `SELECT o.id, o.occurrence_key, o.status, o.recipient_chat_id,
              o.scheduled_local_date, o.scheduled_local_hour, o.claim_token
         FROM scheduled_whatsapp_occurrences o
        WHERE o.job_type = $1
          AND o.company_id IS NOT DISTINCT FROM $2::integer
          AND o.recipient_key = $3
          AND o.recipient_chat_id = $4
          AND o.created_at >= now() - interval '${RETRY_LOOKBACK_HOURS} hours'
          AND (
            o.status IN ('partial', 'failed')
            OR (
              o.status = 'claimed'
              AND o.delivery_started_at IS NULL
              AND o.claim_expires_at < now()
            )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM scheduled_whatsapp_attachments a
             WHERE a.occurrence_id = o.id
               AND a.status = 'sending'
          )
        ORDER BY o.scheduled_local_date DESC, o.scheduled_local_hour DESC, o.id DESC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [input.jobType, input.companyId ?? null, input.recipientKey, input.recipientChatId]
    );

    if (!candidate.rows.length) {
      await client.query("COMMIT");
      return null;
    }

    const row = candidate.rows[0];
    const acquired = await acquireExistingOccurrence(client, Number(row.id), claimToken);
    if (!acquired) {
      await client.query("COMMIT");
      return null;
    }
    row.status = "claimed";
    row.claim_token = claimToken;
    const claim = await loadClaim(client, row, true);
    await client.query("COMMIT");
    logger.info("[ScheduledWhatsApp] retry occurrence claimed", {
      jobType: input.jobType,
      occurrenceKey: claim.occurrenceKey,
      recipient: input.recipientKey,
      result: "retry_claimed",
    });
    return claim;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function hasRetryableScheduledWhatsAppOccurrence(jobType: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM scheduled_whatsapp_occurrences o
      WHERE o.job_type = $1
        AND o.created_at >= now() - interval '${RETRY_LOOKBACK_HOURS} hours'
        AND (
          (
            o.status IN ('partial', 'failed')
            AND (o.claim_token IS NULL OR o.claim_expires_at < now())
          )
          OR (
            o.status = 'claimed'
            AND o.delivery_started_at IS NULL
            AND o.claim_expires_at < now()
          )
          OR (
            o.status = 'delivering'
            AND o.claim_expires_at < now()
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_whatsapp_attachments a
           WHERE a.occurrence_id = o.id AND a.status = 'sending'
        )
      LIMIT 1`,
    [jobType]
  );
  return Boolean(result.rowCount);
}

export async function recordScheduledWhatsAppAttachmentPreparationFailure(input: {
  claim: ScheduledWhatsAppClaim;
  attachmentKey: string;
  error: unknown;
}): Promise<number | null> {
  if (!input.claim.acquired || !input.claim.claimToken) return null;
  const message = getErrorMessage(input.error) || "Attachment preparation failed";
  const result = await pool.query<{ attempt_count: number }>(
    `UPDATE scheduled_whatsapp_attachments a
        SET status = 'failed',
            attempt_count = attempt_count + 1,
            last_error = $4,
            completed_at = now(),
            updated_at = now()
       FROM scheduled_whatsapp_occurrences o
      WHERE a.occurrence_id = $1
        AND a.attachment_key = $2
        AND a.status IN ('pending', 'failed')
        AND o.id = a.occurrence_id
        AND o.claim_token = $3
        AND o.claim_expires_at > now()
      RETURNING a.attempt_count`,
    [input.claim.id, input.attachmentKey, input.claim.claimToken, message.slice(0, 2000)]
  );
  return result.rows.length ? Number(result.rows[0].attempt_count) : null;
}

export async function beginScheduledWhatsAppAttachmentAttempt(
  claim: ScheduledWhatsAppClaim,
  attachmentKey: string
): Promise<number | null> {
  if (!claim.acquired || !claim.claimToken) return null;
  const result = await pool.query<{ attempt_count: number }>(
    `UPDATE scheduled_whatsapp_attachments a
        SET status = 'sending',
            attempt_count = attempt_count + 1,
            last_error = NULL,
            started_at = now(),
            updated_at = now()
       FROM scheduled_whatsapp_occurrences o
      WHERE a.occurrence_id = $1
        AND a.attachment_key = $2
        AND a.status IN ('pending', 'failed')
        AND o.id = a.occurrence_id
        AND o.claim_token = $3
        AND o.claim_expires_at > now()
      RETURNING a.attempt_count`,
    [claim.id, attachmentKey, claim.claimToken]
  );
  if (!result.rows.length) return null;

  await pool.query(
    `UPDATE scheduled_whatsapp_occurrences
        SET status = 'delivering',
            delivery_started_at = COALESCE(delivery_started_at, now()),
            updated_at = now()
      WHERE id = $1 AND claim_token = $2`,
    [claim.id, claim.claimToken]
  );
  return Number(result.rows[0].attempt_count);
}

export async function finishScheduledWhatsAppAttachmentAttempt(input: {
  claim: ScheduledWhatsAppClaim;
  attachmentKey: string;
  success: boolean;
  error?: string | null;
}): Promise<void> {
  const { claim, attachmentKey, success } = input;
  const error = input.error ? input.error.slice(0, 2000) : null;
  await pool.query(
    `UPDATE scheduled_whatsapp_attachments a
        SET status = $4,
            last_error = $5,
            sent_at = CASE WHEN $4 = 'sent' THEN now() ELSE sent_at END,
            completed_at = now(),
            updated_at = now()
       FROM scheduled_whatsapp_occurrences o
      WHERE a.occurrence_id = $1
        AND a.attachment_key = $2
        AND o.id = a.occurrence_id
        AND o.claim_token = $3
        AND a.status = 'sending'`,
    [claim.id, attachmentKey, claim.claimToken, success ? "sent" : "failed", error]
  );

  // Keep the active owner lease fresh after a completed external call. If the
  // process dies after persisting the attachment result, a later scheduler can
  // safely recover the expired "delivering" occurrence because no attachment
  // remains in the ambiguous "sending" state.
  await pool.query(
    `UPDATE scheduled_whatsapp_occurrences
        SET claim_expires_at = now() + interval '${CLAIM_LEASE_MINUTES} minutes',
            updated_at = now()
      WHERE id = $1 AND claim_token = $2`,
    [claim.id, claim.claimToken]
  );
}

export async function finalizeScheduledWhatsAppOccurrence(
  claim: ScheduledWhatsAppClaim
): Promise<{ allSent: boolean; status: ScheduledWhatsAppOccurrenceStatus; error: string | null }> {
  const aggregate = await pool.query<{
    total: number;
    sent: number;
    failed: number;
    sending: number;
    last_error: string | null;
  }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'sending')::int AS sending,
            (
              SELECT last_error
                FROM scheduled_whatsapp_attachments x
               WHERE x.occurrence_id = $1 AND x.last_error IS NOT NULL
               ORDER BY x.updated_at DESC, x.id DESC
               LIMIT 1
            ) AS last_error
       FROM scheduled_whatsapp_attachments
      WHERE occurrence_id = $1`,
    [claim.id]
  );
  const state = aggregate.rows[0] ?? { total: 0, sent: 0, failed: 0, sending: 0, last_error: null };
  let status: ScheduledWhatsAppOccurrenceStatus = "failed";
  if (state.total > 0 && state.sent === state.total) status = "sent";
  else if (state.sending > 0) status = "delivering";
  else if (state.sent > 0) status = "partial";

  const releaseClaim = status !== "delivering";
  await pool.query(
    `UPDATE scheduled_whatsapp_occurrences
        SET status = $3,
            last_error = $4,
            completed_at = CASE WHEN $3 = 'sent' THEN now() ELSE completed_at END,
            claim_token = CASE WHEN $5::boolean THEN NULL ELSE claim_token END,
            claim_expires_at = CASE WHEN $5::boolean THEN NULL ELSE claim_expires_at END,
            updated_at = now()
      WHERE id = $1 AND claim_token = $2`,
    [claim.id, claim.claimToken, status, state.last_error, releaseClaim]
  );

  return { allSent: status === "sent", status, error: state.last_error };
}

export async function logScheduledWhatsAppAttachmentResult(input: {
  claim: ScheduledWhatsAppClaim;
  recipient: string;
  attachment: string;
  attempt: number;
  success: boolean;
  error?: unknown;
}): Promise<void> {
  const details = {
    occurrenceKey: input.claim.occurrenceKey,
    recipient: input.recipient,
    attachment: input.attachment,
    attempt: input.attempt,
    result: input.success ? "sent" : "failed",
    error: input.success ? undefined : getErrorMessage(input.error),
  };
  if (input.success) logger.info("[ScheduledWhatsApp] attachment result", details);
  else logger.error("[ScheduledWhatsApp] attachment result", details);
}
