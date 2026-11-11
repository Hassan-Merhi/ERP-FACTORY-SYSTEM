-- Stock Transfer Order WhatsApp approval, Phase 1. Additive only.
-- This migration does not approve, move, post, or resend anything.
-- Existing transfers remain workflow_origin='stock_transfer'; only future order-screen creations are tagged.
ALTER TABLE stock_transfer_vouchers ADD COLUMN IF NOT EXISTS workflow_origin text NOT NULL DEFAULT 'stock_transfer';

DO $sto_origin$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sto_transfer_origin_ck' AND conrelid = 'stock_transfer_vouchers'::regclass) THEN ALTER TABLE stock_transfer_vouchers ADD CONSTRAINT sto_transfer_origin_ck CHECK (workflow_origin IN ('stock_transfer','stock_transfer_order')) NOT VALID; END IF; END $sto_origin$;

CREATE TABLE IF NOT EXISTS stock_transfer_order_approval_settings (
 company_id integer PRIMARY KEY REFERENCES companies(id) ON DELETE RESTRICT,
 enabled boolean NOT NULL DEFAULT false,
 approval_group_chat_id text,
 authorized_phone_e164 varchar(21),
 updated_by varchar(255),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sto_wa_group_ck CHECK (approval_group_chat_id IS NULL OR approval_group_chat_id ~ '^[0-9]{5,25}@g[.]us$'),
 CONSTRAINT sto_wa_phone_ck CHECK (authorized_phone_e164 IS NULL OR authorized_phone_e164 ~ '^\+[1-9][0-9]{6,14}$')
);

CREATE TABLE IF NOT EXISTS stock_transfer_order_destination_recipients (
 id bigserial PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 destination_location_id integer NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
 chat_id text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 updated_by varchar(255),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sto_wa_dest_company_location_uq UNIQUE(company_id,destination_location_id),
 CONSTRAINT sto_wa_dest_chat_ck CHECK (chat_id ~ '^[0-9]{5,25}@(g[.]us|c[.]us)$')
);

CREATE TABLE IF NOT EXISTS stock_transfer_order_approval_batches (
 id bigserial PRIMARY KEY,
 batch_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 company_id integer NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 destination_location_id integer NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'draft',
 approval_group_chat_id text NOT NULL,
 authorized_phone_e164 varchar(21) NOT NULL,
 whatsapp_instance_id text,
 request_message_id text,
 created_by varchar(255) NOT NULL,
 requested_at timestamptz,
 reviewed_at timestamptz,
 reviewed_by_phone_e164 varchar(21),
 decline_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sto_wa_batches_company_id_uq UNIQUE(company_id,id),
 CONSTRAINT sto_wa_batch_status_ck CHECK (status IN ('draft','requested','approved','declined','stale','cancelled')),
 CONSTRAINT sto_wa_batch_group_ck CHECK (approval_group_chat_id ~ '^[0-9]{5,25}@g[.]us$'),
 CONSTRAINT sto_wa_batch_phone_ck CHECK (authorized_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
 CONSTRAINT sto_wa_request_id_ck CHECK ((request_message_id IS NULL AND whatsapp_instance_id IS NULL) OR (request_message_id IS NOT NULL AND whatsapp_instance_id IS NOT NULL)),
 CONSTRAINT sto_wa_requested_at_ck CHECK (status <> 'requested' OR requested_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS sto_wa_batch_message_uk ON stock_transfer_order_approval_batches (whatsapp_instance_id,approval_group_chat_id,request_message_id) WHERE request_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sto_wa_batch_company_status_idx ON stock_transfer_order_approval_batches (company_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS stock_transfer_order_approval_batch_items (
 id bigserial PRIMARY KEY,
 company_id integer NOT NULL,
 batch_id bigint NOT NULL,
 transfer_id integer NOT NULL REFERENCES stock_transfer_vouchers(id) ON DELETE RESTRICT,
 voucher_number_snapshot varchar(100) NOT NULL,
 item_hash_snapshot varchar(64) NOT NULL,
 reservation_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sto_wa_items_batch_fk FOREIGN KEY(company_id,batch_id) REFERENCES stock_transfer_order_approval_batches(company_id,id) ON DELETE RESTRICT,
 CONSTRAINT sto_wa_items_identity_uq UNIQUE(company_id,batch_id,transfer_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS sto_wa_active_transfer_uk ON stock_transfer_order_approval_batch_items(company_id,transfer_id) WHERE reservation_active;

CREATE INDEX IF NOT EXISTS sto_wa_items_batch_idx ON stock_transfer_order_approval_batch_items(company_id,batch_id);

CREATE TABLE IF NOT EXISTS stock_transfer_order_approval_batch_revisions (
 id bigserial PRIMARY KEY,
 company_id integer NOT NULL,
 batch_id bigint NOT NULL,
 transfer_id integer NOT NULL,
 revision_id integer NOT NULL REFERENCES stock_transfer_revisions(id) ON DELETE RESTRICT,
 revision_number_snapshot integer NOT NULL,
 payload_hash_snapshot varchar(64),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sto_wa_revision_item_fk FOREIGN KEY(company_id,batch_id,transfer_id) REFERENCES stock_transfer_order_approval_batch_items(company_id,batch_id,transfer_id) ON DELETE RESTRICT,
 CONSTRAINT sto_wa_revision_unique UNIQUE(company_id,batch_id,revision_id)
);

CREATE INDEX IF NOT EXISTS sto_wa_revisions_batch_idx ON stock_transfer_order_approval_batch_revisions(company_id,batch_id,transfer_id);

CREATE TABLE IF NOT EXISTS stock_transfer_order_approval_events (
 id bigserial PRIMARY KEY,
 company_id integer NOT NULL,
 batch_id bigint NOT NULL,
 event_type text NOT NULL,
 whatsapp_instance_id text,
 provider_message_id text,
 sender_chat_id text,
 approval_group_chat_id text,
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sto_wa_events_batch_fk FOREIGN KEY(company_id,batch_id) REFERENCES stock_transfer_order_approval_batches(company_id,id) ON DELETE RESTRICT,
 CONSTRAINT sto_wa_event_type_ck CHECK (event_type IN ('draft_created','request_sent','request_stale','done_received','decline_received','approved','declined','ignored','delivery_queued','delivery_accepted','delivery_failed','delivery_uncertain','cancelled')),
 CONSTRAINT sto_wa_events_details_ck CHECK (jsonb_typeof(details)='object')
);

CREATE UNIQUE INDEX IF NOT EXISTS sto_wa_event_dedupe_uk ON stock_transfer_order_approval_events (company_id,whatsapp_instance_id,provider_message_id,event_type) WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sto_wa_events_batch_idx ON stock_transfer_order_approval_events(company_id,batch_id,occurred_at DESC);

CREATE TABLE IF NOT EXISTS stock_transfer_order_approval_deliveries (
 id bigserial PRIMARY KEY,
 company_id integer NOT NULL,
 batch_id bigint NOT NULL,
 recipient_kind text NOT NULL,
 recipient_chat_id text NOT NULL,
 status text NOT NULL DEFAULT 'pending',
 workbook_storage_key text,
 workbook_sha256 varchar(64),
 filename text,
 provider_message_id text,
 claim_token uuid,
 claim_expires_at timestamptz,
 attempt_count integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 last_error text,
 accepted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sto_wa_delivery_batch_fk FOREIGN KEY(company_id,batch_id) REFERENCES stock_transfer_order_approval_batches(company_id,id) ON DELETE RESTRICT,
 CONSTRAINT sto_wa_delivery_kind_ck CHECK (recipient_kind IN ('approval_group','destination')),
 CONSTRAINT sto_wa_delivery_status_ck CHECK (status IN ('pending','sending','accepted','failed','uncertain')),
 CONSTRAINT sto_wa_delivery_attempt_ck CHECK (attempt_count >= 0),
 CONSTRAINT sto_wa_delivery_identity_uq UNIQUE(company_id,batch_id,recipient_kind)
);

CREATE INDEX IF NOT EXISTS sto_wa_delivery_pending_idx ON stock_transfer_order_approval_deliveries(company_id,available_at,id) WHERE status IN ('pending','failed');

CREATE INDEX IF NOT EXISTS sto_wa_delivery_batch_idx ON stock_transfer_order_approval_deliveries(company_id,batch_id);

ALTER TABLE stock_transfer_order_approval_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE stock_transfer_order_approval_settings FORCE ROW LEVEL SECURITY;

DO $sto_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='stock_transfer_order_approval_settings' AND policyname='sto_wa_company_scope') THEN CREATE POLICY sto_wa_company_scope ON stock_transfer_order_approval_settings USING (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer) WITH CHECK (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer); END IF; END $sto_policy$;

ALTER TABLE stock_transfer_order_destination_recipients ENABLE ROW LEVEL SECURITY;

ALTER TABLE stock_transfer_order_destination_recipients FORCE ROW LEVEL SECURITY;

DO $sto_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='stock_transfer_order_destination_recipients' AND policyname='sto_wa_company_scope') THEN CREATE POLICY sto_wa_company_scope ON stock_transfer_order_destination_recipients USING (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer) WITH CHECK (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer); END IF; END $sto_policy$;

ALTER TABLE stock_transfer_order_approval_batches ENABLE ROW LEVEL SECURITY;

ALTER TABLE stock_transfer_order_approval_batches FORCE ROW LEVEL SECURITY;

DO $sto_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='stock_transfer_order_approval_batches' AND policyname='sto_wa_company_scope') THEN CREATE POLICY sto_wa_company_scope ON stock_transfer_order_approval_batches USING (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer) WITH CHECK (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer); END IF; END $sto_policy$;

ALTER TABLE stock_transfer_order_approval_batch_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE stock_transfer_order_approval_batch_items FORCE ROW LEVEL SECURITY;

DO $sto_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='stock_transfer_order_approval_batch_items' AND policyname='sto_wa_company_scope') THEN CREATE POLICY sto_wa_company_scope ON stock_transfer_order_approval_batch_items USING (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer) WITH CHECK (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer); END IF; END $sto_policy$;

ALTER TABLE stock_transfer_order_approval_batch_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE stock_transfer_order_approval_batch_revisions FORCE ROW LEVEL SECURITY;

DO $sto_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='stock_transfer_order_approval_batch_revisions' AND policyname='sto_wa_company_scope') THEN CREATE POLICY sto_wa_company_scope ON stock_transfer_order_approval_batch_revisions USING (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer) WITH CHECK (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer); END IF; END $sto_policy$;

ALTER TABLE stock_transfer_order_approval_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE stock_transfer_order_approval_events FORCE ROW LEVEL SECURITY;

DO $sto_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='stock_transfer_order_approval_events' AND policyname='sto_wa_company_scope') THEN CREATE POLICY sto_wa_company_scope ON stock_transfer_order_approval_events USING (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer) WITH CHECK (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer); END IF; END $sto_policy$;

ALTER TABLE stock_transfer_order_approval_deliveries ENABLE ROW LEVEL SECURITY;

ALTER TABLE stock_transfer_order_approval_deliveries FORCE ROW LEVEL SECURITY;

DO $sto_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='stock_transfer_order_approval_deliveries' AND policyname='sto_wa_company_scope') THEN CREATE POLICY sto_wa_company_scope ON stock_transfer_order_approval_deliveries USING (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer) WITH CHECK (current_setting('app.company_scope_maintenance',true)='on' OR company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer); END IF; END $sto_policy$;
