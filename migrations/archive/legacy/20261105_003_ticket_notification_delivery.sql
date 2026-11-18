-- Ticket notifications Phase 4: per-user opt-in and durable, claimable deliveries.
CREATE TABLE IF NOT EXISTS support_ticket_notification_contacts (
 company_id INTEGER NOT NULL,
 user_id VARCHAR(100) NOT NULL,
 email TEXT,
 whatsapp_chat_id VARCHAR(48),
 email_enabled BOOLEAN NOT NULL DEFAULT false,
 whatsapp_enabled BOOLEAN NOT NULL DEFAULT false,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,user_id),
 CONSTRAINT support_ticket_contacts_email_ck CHECK(email IS NULL OR (length(email) <= 254 AND email LIKE '%@%')),
 CONSTRAINT support_ticket_contacts_wa_ck CHECK(whatsapp_chat_id IS NULL OR whatsapp_chat_id ~ '^[0-9]{7,20}@c[.]us$')
);
ALTER TABLE support_ticket_outbox
  ADD COLUMN IF NOT EXISTS claim_token VARCHAR(80),
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;
CREATE INDEX IF NOT EXISTS support_ticket_outbox_claim_idx
  ON support_ticket_outbox (available_at, claim_expires_at)
  WHERE processed_at IS NULL;
ALTER TABLE support_ticket_notifications
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS support_ticket_notifications_pending_idx
  ON support_ticket_notifications(next_attempt_at,id)
  WHERE delivery_status = 'pending';
