// Extracted from ./scheduledWhatsAppDelivery.ts to keep that module under the source-size cap.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../../db";
import { logger } from "../../lib/logger";

export type ScheduledWhatsAppOccurrenceStatus = "claimed" | "delivering" | "partial" | "failed" | "sent";

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

export const CLAIM_LEASE_MINUTES = 15;

export const RETRY_LOOKBACK_HOURS = 36;

function normalizeKeyPart(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_.:@-]/g, "_");
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

export async function loadClaim(
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

export async function acquireExistingOccurrence(
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
