/**
 * Always-on schema guards for WhatsApp delivery and rental/property writes.
 * No behavior or migration SQL changes.
 */
import type { Pool } from "pg";
import { logger } from "../../lib/logger";
import { scheduledWhatsAppDeliveryTracking } from "../../startup-schema/030-scheduled-whatsapp-delivery-tracking";

export async function ensureScheduledWhatsAppDeliveryTrackingSchema(pool: Pool): Promise<void> {
  const verifyOnly = process.env.SCHEDULED_WHATSAPP_SCHEMA_MODE === "verify-only";
  // The original boot-time writer stays active by default until the full
  // startup registry and migration ledgers have been reconciled. On staging,
  // verify-only mode never executes any CREATE/ALTER or historical DML.
  if (!verifyOnly) {
    for (const statement of scheduledWhatsAppDeliveryTracking) {
      await pool.query(statement);
    }
  }

  const verification = await pool.query<{
    occurrences_table: string | null;
    attachments_table: string | null;
  }>(
    `SELECT
       to_regclass('public.scheduled_whatsapp_occurrences')::text AS occurrences_table,
       to_regclass('public.scheduled_whatsapp_attachments')::text AS attachments_table`
  );

  const row = verification.rows[0];
  if (!row?.occurrences_table || !row?.attachments_table) {
    throw new Error("SCHEDULED_WHATSAPP_DELIVERY_TRACKING_SCHEMA_UNAVAILABLE");
  }

  if (verifyOnly) {
    const readiness = await pool.query<{
      occurrence_key_unique: boolean;
      attachment_key_unique: boolean;
      retry_idx: boolean;
      recipient_idx: boolean;
      attachment_status_idx: boolean;
    }>(`
      SELECT
        EXISTS(SELECT 1 FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='scheduled_whatsapp_occurrences'
            AND co.conname='scheduled_whatsapp_occurrences_key_unique' AND co.contype='u'
            AND co.convalidated) AS occurrence_key_unique,
        EXISTS(SELECT 1 FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='scheduled_whatsapp_attachments'
            AND co.conname='scheduled_whatsapp_attachments_occurrence_key_unique'
            AND co.contype='u' AND co.convalidated) AS attachment_key_unique,
        EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='scheduled_whatsapp_occurrences_retry_idx'
            AND i.indisvalid AND i.indisready) AS retry_idx,
        EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='scheduled_whatsapp_occurrences_recipient_idx'
            AND i.indisvalid AND i.indisready) AS recipient_idx,
        EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='scheduled_whatsapp_attachments_status_idx'
            AND i.indisvalid AND i.indisready) AS attachment_status_idx
    `);
    if (!readiness.rows[0] || Object.values(readiness.rows[0]).some((value) => value !== true)) {
      throw new Error("Scheduled WhatsApp schema verification failed; apply reviewed controlled migration 008 first");
    }
  }
  logger.info(
    verifyOnly
      ? "[startup] ✓ Scheduled WhatsApp delivery tracking schema verified read-only"
      : "[startup] ✓ Scheduled WhatsApp delivery tracking schema ensured"
  );
}

/**
 * Contract creation is used even when the bulk startup migrations are disabled
 * in production. Older property_contracts tables may predate these fields;
 * CREATE TABLE IF NOT EXISTS does not add them to an existing table.
 * Inspect first to avoid taking an unnecessary table DDL lock on every boot.
 * No contracts, payments, or accounting entries are modified.
 */
export async function ensureRentalContractCreateColumns(pool: Pool): Promise<void> {
  const result = await pool.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'property_contracts'
  `);
  const existing = new Set(result.rows.map((row) => row.column_name));
  const required = [
    { name: "statement_note", definition: "TEXT" },
    { name: "is_internal", definition: "BOOLEAN NOT NULL DEFAULT FALSE" },
    { name: "linked_company_id", definition: "INTEGER" },
    { name: "currency", definition: "TEXT NOT NULL DEFAULT 'USD'" },
  ] as const;
  for (const column of required) {
    if (!existing.has(column.name)) {
      await pool.query(`ALTER TABLE property_contracts ADD COLUMN IF NOT EXISTS ${column.name} ${column.definition}`);
    }
  }
}

/**
 * The Factory/ERP rental unit insert uses these columns even on installations
 * that disable bulk startup migrations. Older databases can already contain
 * property_units, so CREATE TABLE IF NOT EXISTS in the bulk migration does not
 * repair an incomplete table.
 *
 * Only missing columns are added; existing units, leases and accounting entries
 * are never modified. A healthy installation performs no write or table lock.
 */
export async function ensurePropertyUnitsWriteSchema(pool: Pool): Promise<void> {
  const existing = await pool.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'property_units'`
  );
  if (existing.rows.length === 0) {
    throw new Error("RENTAL_PROPERTY_UNITS_TABLE_MISSING: apply the base rental migration");
  }
  const present = new Set(existing.rows.map((row) => row.column_name));
  const additions: ReadonlyArray<readonly [string, string]> = [
    ["module", "TEXT NOT NULL DEFAULT 'PROPERTIES'"],
    ["unit_type", "TEXT"],
    ["location_group", "TEXT"],
    ["unit_number", "TEXT"],
    ["size", "TEXT"],
    ["dimensions", "TEXT"],
    ["notes", "TEXT"],
    ["active", "BOOLEAN NOT NULL DEFAULT TRUE"],
    ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
    ["created_at", "TIMESTAMP NOT NULL DEFAULT NOW()"],
  ];
  const missing = additions.filter(([column]) => !present.has(column));
  if (!missing.length) return;
  await pool.query(
    `ALTER TABLE public.property_units ${missing
      .map(([column, type]) => `ADD COLUMN IF NOT EXISTS "${column}" ${type}`)
      .join(", ")}`
  );
  logger.info("[startup] ✓ Rental unit creation columns repaired", {
    columns: missing.map(([column]) => column),
  });
}
