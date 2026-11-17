-- Ticket Management Phase 1: additive schema only; no existing voucher/stock mutation.
CREATE TABLE IF NOT EXISTS support_tickets (
 id BIGSERIAL PRIMARY KEY, company_id INTEGER NOT NULL, ticket_number VARCHAR(40) NOT NULL,
 source_mode VARCHAR(12) NOT NULL CHECK(source_mode IN ('erp','factory')),
 category VARCHAR(80) NOT NULL, priority VARCHAR(16) NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
 status VARCHAR(24) NOT NULL DEFAULT 'open' CHECK(status IN ('open','seen','working','finalized','reopened')),
 title VARCHAR(240) NOT NULL, description TEXT NOT NULL,
 created_by VARCHAR(100) NOT NULL, assigned_to VARCHAR(100) NOT NULL, reported_user_id VARCHAR(100),
 resolution_note TEXT, finalized_by VARCHAR(100),
 first_seen_at TIMESTAMPTZ, started_at TIMESTAMPTZ, finalized_at TIMESTAMPTZ,
 due_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
 reopened_count INTEGER NOT NULL DEFAULT 0 CHECK(reopened_count >= 0),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT support_ticket_company_id_unique UNIQUE(company_id,id),
 CONSTRAINT support_tickets_company_number_uq UNIQUE(company_id,ticket_number)
);
CREATE INDEX IF NOT EXISTS support_tickets_company_status_idx ON support_tickets(company_id,status);
CREATE INDEX IF NOT EXISTS support_tickets_company_assignee_idx ON support_tickets(company_id,assigned_to);
CREATE INDEX IF NOT EXISTS support_tickets_company_due_idx ON support_tickets(company_id,due_at);

CREATE TABLE IF NOT EXISTS support_ticket_participants (
 id BIGSERIAL PRIMARY KEY, ticket_id BIGINT NOT NULL, company_id INTEGER NOT NULL,
 user_id VARCHAR(100) NOT NULL, added_by VARCHAR(100) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT support_ticket_participant_uq UNIQUE(ticket_id,user_id),
 CONSTRAINT support_ticket_participant_ticket_fk FOREIGN KEY(company_id,ticket_id) REFERENCES support_tickets(company_id,id)
);
CREATE INDEX IF NOT EXISTS support_ticket_participant_company_idx ON support_ticket_participants(company_id,user_id);
CREATE TABLE IF NOT EXISTS support_ticket_records (
 id BIGSERIAL PRIMARY KEY, ticket_id BIGINT NOT NULL, company_id INTEGER NOT NULL,
 record_type VARCHAR(80) NOT NULL, record_id VARCHAR(120) NOT NULL,
 display_reference VARCHAR(160) NOT NULL, snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT support_ticket_records_ticket_fk FOREIGN KEY(company_id,ticket_id) REFERENCES support_tickets(company_id,id)
);
CREATE INDEX IF NOT EXISTS support_ticket_records_ticket_idx ON support_ticket_records(ticket_id);
CREATE TABLE IF NOT EXISTS support_ticket_attachments (
 id BIGSERIAL PRIMARY KEY, ticket_id BIGINT NOT NULL, company_id INTEGER NOT NULL,
 uploaded_by VARCHAR(100) NOT NULL, storage_key TEXT NOT NULL, file_name TEXT NOT NULL,
 mime_type VARCHAR(120) NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
 sha256 VARCHAR(64), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT support_ticket_attachments_ticket_fk FOREIGN KEY(company_id,ticket_id) REFERENCES support_tickets(company_id,id)
);
CREATE INDEX IF NOT EXISTS support_ticket_attachments_ticket_idx ON support_ticket_attachments(ticket_id);
CREATE TABLE IF NOT EXISTS support_ticket_comments (
 id BIGSERIAL PRIMARY KEY, ticket_id BIGINT NOT NULL, company_id INTEGER NOT NULL,
 author_id VARCHAR(100) NOT NULL, body TEXT NOT NULL CHECK(length(btrim(body)) > 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT support_ticket_comments_ticket_fk FOREIGN KEY(company_id,ticket_id) REFERENCES support_tickets(company_id,id)
);
CREATE INDEX IF NOT EXISTS support_ticket_comments_ticket_idx ON support_ticket_comments(ticket_id);
CREATE TABLE IF NOT EXISTS support_ticket_events (
 id BIGSERIAL PRIMARY KEY, ticket_id BIGINT NOT NULL, company_id INTEGER NOT NULL,
 actor_id VARCHAR(100) NOT NULL, event_type VARCHAR(64) NOT NULL,
 before_state JSONB, after_state JSONB, reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT support_ticket_events_ticket_fk FOREIGN KEY(company_id,ticket_id) REFERENCES support_tickets(company_id,id)
);
CREATE INDEX IF NOT EXISTS support_ticket_events_ticket_idx ON support_ticket_events(ticket_id,created_at);
-- An append-only audit ledger: reject modification even from ordinary application DELETE/UPDATE paths.
CREATE OR REPLACE FUNCTION support_ticket_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Ticket audit events are immutable' USING ERRCODE = '23514'; END;
$$;
DROP TRIGGER IF EXISTS support_ticket_events_immutable_trg ON support_ticket_events;
CREATE TRIGGER support_ticket_events_immutable_trg BEFORE UPDATE OR DELETE ON support_ticket_events
FOR EACH ROW EXECUTE FUNCTION support_ticket_event_immutable();

CREATE TABLE IF NOT EXISTS support_ticket_outbox (
 id BIGSERIAL PRIMARY KEY, company_id INTEGER NOT NULL, ticket_id BIGINT NOT NULL,
 event_key VARCHAR(180) NOT NULL UNIQUE, event_type VARCHAR(64) NOT NULL, payload JSONB NOT NULL,
 available_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ,
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT support_ticket_outbox_ticket_fk FOREIGN KEY(company_id,ticket_id) REFERENCES support_tickets(company_id,id)
);
CREATE INDEX IF NOT EXISTS support_ticket_outbox_pending_idx ON support_ticket_outbox(processed_at,available_at);
CREATE TABLE IF NOT EXISTS support_ticket_notifications (
 id BIGSERIAL PRIMARY KEY, company_id INTEGER NOT NULL, ticket_id BIGINT NOT NULL,
 outbox_id BIGINT NOT NULL REFERENCES support_ticket_outbox(id),
 recipient_user_id VARCHAR(100) NOT NULL, channel VARCHAR(16) NOT NULL CHECK(channel IN ('in_app','email','whatsapp')),
 delivery_status VARCHAR(24) NOT NULL DEFAULT 'pending',
 provider_message_id TEXT, sent_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, read_at TIMESTAMPTZ,
 error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT support_ticket_notification_delivery_uq UNIQUE(outbox_id,recipient_user_id,channel),
 CONSTRAINT support_ticket_notification_ticket_fk FOREIGN KEY(company_id,ticket_id) REFERENCES support_tickets(company_id,id)
);
