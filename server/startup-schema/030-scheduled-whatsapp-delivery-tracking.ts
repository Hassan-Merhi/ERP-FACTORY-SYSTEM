/**
 * Durable scheduled WhatsApp occurrence and per-attachment delivery state.
 *
 * The occurrence key is globally unique so overlapping Render instances cannot
 * both own the same scheduled occurrence. Attachment rows make partial success
 * retry-safe: sent files stay sent, while known failures remain retryable.
 */
export const scheduledWhatsAppDeliveryTracking: string[] = [
  `CREATE TABLE IF NOT EXISTS scheduled_whatsapp_occurrences (
      id bigserial PRIMARY KEY,
      job_type text NOT NULL,
      company_id integer REFERENCES companies(id) ON DELETE SET NULL,
      recipient_key text NOT NULL,
      recipient_chat_id text NOT NULL,
      scheduled_local_date date NOT NULL,
      scheduled_local_hour integer NOT NULL,
      occurrence_key text NOT NULL,
      status text NOT NULL DEFAULT 'claimed',
      claim_token text,
      claim_expires_at timestamptz,
      delivery_started_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CONSTRAINT scheduled_whatsapp_occurrences_hour_check
        CHECK (scheduled_local_hour BETWEEN 0 AND 23),
      CONSTRAINT scheduled_whatsapp_occurrences_status_check
        CHECK (status IN ('claimed', 'delivering', 'partial', 'failed', 'sent')),
      CONSTRAINT scheduled_whatsapp_occurrences_key_unique UNIQUE (occurrence_key)
    )`,
  `CREATE TABLE IF NOT EXISTS scheduled_whatsapp_attachments (
      id bigserial PRIMARY KEY,
      occurrence_id bigint NOT NULL REFERENCES scheduled_whatsapp_occurrences(id) ON DELETE CASCADE,
      attachment_key text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempt_count integer NOT NULL DEFAULT 0,
      last_error text,
      started_at timestamptz,
      completed_at timestamptz,
      sent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT scheduled_whatsapp_attachments_status_check
        CHECK (status IN ('pending', 'sending', 'failed', 'sent')),
      CONSTRAINT scheduled_whatsapp_attachments_occurrence_key_unique
        UNIQUE (occurrence_id, attachment_key)
    )`,
  `CREATE INDEX IF NOT EXISTS scheduled_whatsapp_occurrences_retry_idx
     ON scheduled_whatsapp_occurrences (job_type, status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS scheduled_whatsapp_occurrences_recipient_idx
     ON scheduled_whatsapp_occurrences (job_type, company_id, recipient_key, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS scheduled_whatsapp_attachments_status_idx
     ON scheduled_whatsapp_attachments (occurrence_id, status)`,
];
