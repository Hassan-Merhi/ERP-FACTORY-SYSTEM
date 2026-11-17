-- Phase 3: ticket evidence is private and stored durably in PostgreSQL.
-- Limited to small photos/PDFs (5 MiB each); move to private object storage for larger files.
CREATE TABLE IF NOT EXISTS support_ticket_attachment_blobs (
 attachment_id BIGINT PRIMARY KEY REFERENCES support_ticket_attachments(id) ON DELETE RESTRICT,
 company_id INTEGER NOT NULL,
 content BYTEA NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT support_ticket_blob_nonempty_ck CHECK(octet_length(content) BETWEEN 1 AND 5242880)
);
CREATE INDEX IF NOT EXISTS support_ticket_blob_company_idx ON support_ticket_attachment_blobs(company_id);
