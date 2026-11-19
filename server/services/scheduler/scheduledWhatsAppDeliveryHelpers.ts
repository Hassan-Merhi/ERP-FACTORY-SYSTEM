// Extracted from ./scheduledWhatsAppDelivery.ts
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { type ScheduledWhatsAppClaim } from "./claimScheduledWhatsAppOccurrence";

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
