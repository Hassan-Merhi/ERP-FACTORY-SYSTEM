/**
 * Phase 9: atomic LAN evidence for stock movements (inventory quick adjust).
 * Its own gapless sequence and cloud cursors ("stock" stream), separate from
 * vouchers and pressing, so a held stock movement never blocks other streams.
 *
 * Delivery is the generic Phase 9 event stream: the LAN relay
 * (scripts/edge/relay-event-outbox.mjs) stages these rows in the cloud and the
 * operator apply (server/edge/phase9OperatorApply.ts) replays each movement
 * exactly once as a quantity delta. The schema is installed by the reviewed
 * DBA step (server/edge/offlineSchemaInstall.ts), never at startup; without it
 * the LAN write guard refuses the route instead of failing mid-adjustment.
 */
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { DbTransaction } from "../db";
import { EdgeRefusal } from "./edgeRefusal";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hashEvidence } from "./edgeSyncStageProtocol.mjs";
import {
  phase9StockAdjustEnvelope,
  phase9StockTransferEnvelope,
  type Phase9StockAdjustEvidence,
  type Phase9StockTransferEvidence,
} from "./phase9StockEnvelope.mjs";
import { phase9StockItemEditEnvelope, type Phase9StockItemEditEvidence } from "./phase9StockItemEditEnvelope.mjs";
import {
  PHASE9_LAN_ITEM_ID_BASE,
  PHASE9_STOCK_ITEM_CREATE_KIND,
  PHASE9_STOCK_ITEM_DELETE_KIND,
  phase9StockItemCreateEnvelope,
  phase9StockItemDeleteEnvelope,
  type Phase9StockItemCreateEvidence,
  type Phase9StockItemDeleteEvidence,
} from "./phase9StockItemLifecycleEnvelope.mjs";
import {
  PHASE9_STOCK_TRANSFER_EDIT_KIND,
  PHASE9_STOCK_TRANSFER_FINALIZE_KIND,
  PHASE9_STOCK_TRANSFER_REVISION_KIND,
  PHASE9_STOCK_TRANSFER_REVISION_REVIEW_KIND,
  phase9StockTransferEditEnvelope,
  phase9StockTransferFinalizeEnvelope,
  phase9StockTransferRevisionEnvelope,
  phase9StockTransferRevisionReviewEnvelope,
  phase9TransferSnapshot,
  type Phase9RevisionRef,
  type Phase9StockTransferEditEvidence,
  type Phase9StockTransferFinalizeEvidence,
  type Phase9StockTransferRevisionEvidence,
  type Phase9StockTransferRevisionReviewEvidence,
  type Phase9TransferRef,
  type Phase9TransferSnapshot,
} from "./phase9StockTransferWorkflowEnvelope.mjs";

/**
 * local_movement_id is the LAN source row: a canonical stock movement (quick
 * adjust), a stock transfer (transfer) or the edit's own stream sequence (item
 * edit); unique per kind.
 */
const STOCK_OUTBOX_KINDS = [
  "stock.quick-adjust.v1",
  "stock.transfer.v1",
  "stock.item-edit.v1",
  PHASE9_STOCK_ITEM_CREATE_KIND,
  PHASE9_STOCK_ITEM_DELETE_KIND,
  PHASE9_STOCK_TRANSFER_EDIT_KIND,
  PHASE9_STOCK_TRANSFER_FINALIZE_KIND,
  PHASE9_STOCK_TRANSFER_REVISION_KIND,
  PHASE9_STOCK_TRANSFER_REVISION_REVIEW_KIND,
] as const;

export async function ensurePhase9StockOutboxSchema(queryable: Pick<Pool, "query">): Promise<void> {
  if (readFactoryEdgeConfiguration().mode !== "lan") return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_stock_counter (
      site_id UUID PRIMARY KEY,
      last_sequence BIGINT NOT NULL CHECK(last_sequence > 0)
    )
  `);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_stock_outbox (
      site_id UUID NOT NULL,
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      operation_id UUID NOT NULL,
      company_id INTEGER NOT NULL CHECK(company_id > 0),
      actor_user_id TEXT NOT NULL CHECK(length(actor_user_id) > 0),
      local_movement_id BIGINT NOT NULL CHECK(local_movement_id > 0 AND local_movement_id <= 2147483647),
      operation_kind TEXT NOT NULL,
      payload JSONB NOT NULL,
      payload_sha256 CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (site_id, sequence),
      UNIQUE (site_id, operation_id),
      UNIQUE (site_id, operation_kind, local_movement_id)
    )
  `);
  // The allowed kinds are (re)set on every install, so an existing outbox
  // learns new kinds without being rebuilt.
  await queryable.query(
    "ALTER TABLE factory_edge_stock_outbox DROP CONSTRAINT IF EXISTS factory_edge_stock_outbox_operation_kind_check"
  );
  await queryable.query(
    `ALTER TABLE factory_edge_stock_outbox ADD CONSTRAINT factory_edge_stock_outbox_operation_kind_check
       CHECK (operation_kind IN (${STOCK_OUTBOX_KINDS.map((kind) => `'${kind}'`).join(", ")}))`
  );
  // Plan batch 2: items created on this server take their id from a range the
  // cloud never uses, so offline records naming them can be translated to the
  // cloud's item (only the LAN create route draws from it).
  await queryable.query(
    `CREATE SEQUENCE IF NOT EXISTS factory_edge_lan_item_id_seq
       AS integer START WITH ${PHASE9_LAN_ITEM_ID_BASE} MINVALUE ${PHASE9_LAN_ITEM_ID_BASE} MAXVALUE 2147483647`
  );
  // Shared with the pressing install; both are idempotent.
  await queryable.query(`
    CREATE OR REPLACE FUNCTION factory_edge_stock_outbox_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'PHASE9_STOCK_OUTBOX_IMMUTABLE' USING ERRCODE = '23514';
    END $$
  `);
  await queryable.query(`DROP TRIGGER IF EXISTS factory_edge_stock_outbox_no_mutation ON factory_edge_stock_outbox`);
  await queryable.query(`
    CREATE TRIGGER factory_edge_stock_outbox_no_mutation
    BEFORE UPDATE OR DELETE ON factory_edge_stock_outbox
    FOR EACH ROW EXECUTE FUNCTION factory_edge_stock_outbox_immutable()
  `);
}

/** Record the committed movement in the SAME transaction; no-op off the LAN primary. */
export async function capturePhase9StockAdjustTx(
  tx: DbTransaction,
  evidence: Phase9StockAdjustEvidence
): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  // Validate before any statement: invalid evidence aborts the adjustment.
  const event = phase9StockAdjustEnvelope(evidence);
  const payload = JSON.stringify(event);
  const hash = hashEvidence(event);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-stock-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_stock_counter (site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_stock_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_stock_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_movement_id, operation_kind, payload, payload_sha256)
    SELECT ${config.siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${event.localMovementId},
           ${event.kind}, ${payload}::jsonb, ${hash}
    FROM next_sequence
  `);
}

/** Record a committed stock transfer on the same "stock" stream; no-op off the LAN primary. */
export async function capturePhase9StockTransferTx(
  tx: DbTransaction,
  evidence: Phase9StockTransferEvidence
): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  const event = phase9StockTransferEnvelope(evidence);
  const hash = hashEvidence(event);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-stock-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_stock_counter (site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_stock_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_stock_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_movement_id, operation_kind, payload, payload_sha256)
    SELECT ${config.siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${event.localTransferId},
           ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hash}
    FROM next_sequence
  `);
}

/**
 * Record stock-item master edits (one event per call) on the "stock" stream.
 * The edit's local reference is its own stream sequence, taken under the
 * outbox order lock. No-op off the LAN primary.
 */
export async function capturePhase9StockItemEditTx(
  tx: DbTransaction,
  evidence: Omit<Phase9StockItemEditEvidence, "localEditId">
): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-stock-outbox-order'))`);
  const counter = await tx.execute(sql`
    INSERT INTO factory_edge_stock_counter (site_id, last_sequence)
    VALUES (${config.siteId}::uuid, 1)
    ON CONFLICT (site_id)
      DO UPDATE SET last_sequence = factory_edge_stock_counter.last_sequence + 1
    RETURNING last_sequence
  `);
  const sequence = Number((counter.rows[0] as { last_sequence: string | number }).last_sequence);
  const event = phase9StockItemEditEnvelope({ ...evidence, localEditId: sequence });
  await tx.execute(sql`
    INSERT INTO factory_edge_stock_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_movement_id, operation_kind, payload, payload_sha256)
    VALUES (${config.siteId}::uuid, ${sequence}, ${event.requestId}::uuid,
            ${event.companyId}, ${event.actorUserId}, ${event.localEditId},
            ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hashEvidence(event)})
  `);
}

async function appendStockEventTx(
  tx: DbTransaction,
  siteId: string,
  event: { kind: string; requestId: string; companyId: number; actorUserId: string },
  localRef: number
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-stock-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_stock_counter (site_id, last_sequence)
      VALUES (${siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_stock_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_stock_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_movement_id, operation_kind, payload, payload_sha256)
    SELECT ${siteId}::uuid, next_sequence.last_sequence, ${event.requestId}::uuid,
           ${event.companyId}, ${event.actorUserId}, ${localRef},
           ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hashEvidence(event)}
    FROM next_sequence
  `);
}

/** Plan batch 2: a stock item created on the LAN primary; no-op elsewhere. */
export async function capturePhase9StockItemCreateTx(
  tx: DbTransaction,
  evidence: Phase9StockItemCreateEvidence
): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  const event = phase9StockItemCreateEnvelope(evidence);
  await appendStockEventTx(tx, String(config.siteId), event, event.localStockItemId);
}

/** Plan batch 2: a stock item deleted (soft) on the LAN primary; no-op elsewhere. */
export async function capturePhase9StockItemDeleteTx(
  tx: DbTransaction,
  evidence: Phase9StockItemDeleteEvidence
): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  const event = phase9StockItemDeleteEnvelope(evidence);
  await appendStockEventTx(tx, String(config.siteId), event, event.stockItemId);
}

/** The next LAN stock item id (from the reserved range); LAN primary only. */
export async function nextPhase9LanStockItemIdTx(tx: DbTransaction): Promise<number> {
  const result = await tx.execute(sql`SELECT nextval('factory_edge_lan_item_id_seq')::int AS id`);
  const id = Number((result.rows[0] as { id: number | string }).id);
  if (!Number.isSafeInteger(id) || id < PHASE9_LAN_ITEM_ID_BASE)
    throw new EdgeRefusal("PHASE9_LAN_ITEM_ID_RANGE_INVALID");
  return id;
}

/**
 * Plan batch 3: a follow-up record whose local reference is its own stream
 * sequence (the transfer or revision it changes is named in the payload), so
 * any number of edits of one transfer each get their own record.
 */
async function appendStockFollowUpTx<
  T extends { kind: string; requestId: string; companyId: number; actorUserId: string },
>(tx: DbTransaction, siteId: string, build: (localEditId: number) => T): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-stock-outbox-order'))`);
  const counter = await tx.execute(sql`
    INSERT INTO factory_edge_stock_counter (site_id, last_sequence)
    VALUES (${siteId}::uuid, 1)
    ON CONFLICT (site_id)
      DO UPDATE SET last_sequence = factory_edge_stock_counter.last_sequence + 1
    RETURNING last_sequence
  `);
  const sequence = Number((counter.rows[0] as { last_sequence: string | number }).last_sequence);
  const event = build(sequence);
  await tx.execute(sql`
    INSERT INTO factory_edge_stock_outbox
      (site_id, sequence, operation_id, company_id, actor_user_id,
       local_movement_id, operation_kind, payload, payload_sha256)
    VALUES (${siteId}::uuid, ${sequence}, ${event.requestId}::uuid,
            ${event.companyId}, ${event.actorUserId}, ${sequence},
            ${event.kind}, ${JSON.stringify(event)}::jsonb, ${hashEvidence(event)})
  `);
}

function lanSiteId(): string | null {
  const config = readFactoryEdgeConfiguration();
  return config.mode === "lan" && config.primary && config.siteId ? String(config.siteId) : null;
}

/** Was this row created on this LAN server during the outage (recorded on the stock stream)? */
async function recordedOnLanTx(tx: DbTransaction, siteId: string, kind: string, localRef: number): Promise<boolean> {
  const found = await tx.execute(sql`
    SELECT 1 FROM factory_edge_stock_outbox
     WHERE site_id = ${siteId}::uuid AND operation_kind = ${kind} AND local_movement_id = ${localRef}
     LIMIT 1
  `);
  return found.rows.length > 0;
}

/** How an offline record names a transfer: by its LAN record if created offline, else by its shared id. */
export async function phase9TransferRefTx(tx: DbTransaction, transferId: number): Promise<Phase9TransferRef> {
  const siteId = lanSiteId();
  if (siteId && (await recordedOnLanTx(tx, siteId, "stock.transfer.v1", transferId))) {
    return { origin: "lan", localTransferId: transferId };
  }
  return { origin: "cloud", transferId };
}

/** How an offline record names a transfer revision (same rule as transfers). */
export async function phase9RevisionRefTx(tx: DbTransaction, revisionId: number): Promise<Phase9RevisionRef> {
  const siteId = lanSiteId();
  if (siteId && (await recordedOnLanTx(tx, siteId, PHASE9_STOCK_TRANSFER_REVISION_KIND, revisionId))) {
    return { origin: "lan", localRevisionId: revisionId };
  }
  return { origin: "cloud", revisionId };
}

/** The transfer as it stands, locked for the rest of the transaction; null if it does not exist. */
export async function phase9TransferSnapshotTx(
  tx: DbTransaction,
  transferId: number
): Promise<Phase9TransferSnapshot | null> {
  const header = await tx.execute(sql`
    SELECT t.destination_location_id AS "destinationLocationId", t.source_location_id AS "headerSourceId",
           t.inventory_applied AS "inventoryApplied", v.optional
      FROM stock_transfer_vouchers t JOIN vouchers v ON v.id = t.voucher_id
     WHERE t.id = ${transferId}
     FOR UPDATE OF t, v
  `);
  const row = header.rows[0] as
    | { destinationLocationId: number; headerSourceId: number | null; inventoryApplied: boolean; optional: boolean }
    | undefined;
  if (!row) return null;
  const lines = await tx.execute(sql`
    SELECT COALESCE(source_location_id, ${row.headerSourceId}) AS "sourceLocationId",
           stock_item_id AS "stockItemId", quantity::text AS quantity
      FROM stock_transfer_items WHERE transfer_id = ${transferId}
  `);
  return phase9TransferSnapshot(
    row,
    lines.rows as Array<{ sourceLocationId: number; stockItemId: number; quantity: string }>
  );
}

/** Plan batch 3: an edit of an existing transfer; no-op off the LAN primary. */
export async function capturePhase9StockTransferEditTx(
  tx: DbTransaction,
  evidence: Omit<Phase9StockTransferEditEvidence, "localEditId">
): Promise<void> {
  const siteId = lanSiteId();
  if (!siteId) return;
  await appendStockFollowUpTx(tx, siteId, (localEditId) =>
    phase9StockTransferEditEnvelope({ ...evidence, localEditId })
  );
}

/** Plan batch 3: a transfer finalized (approved) on the LAN; no-op off the LAN primary. */
export async function capturePhase9StockTransferFinalizeTx(
  tx: DbTransaction,
  evidence: Omit<Phase9StockTransferFinalizeEvidence, "localEditId">
): Promise<void> {
  const siteId = lanSiteId();
  if (!siteId) return;
  await appendStockFollowUpTx(tx, siteId, (localEditId) =>
    phase9StockTransferFinalizeEnvelope({ ...evidence, localEditId })
  );
}

/** Plan batch 3: a transfer revision created on the LAN (local reference = the revision id). */
export async function capturePhase9StockTransferRevisionTx(
  tx: DbTransaction,
  evidence: Phase9StockTransferRevisionEvidence
): Promise<void> {
  const siteId = lanSiteId();
  if (!siteId) return;
  const event = phase9StockTransferRevisionEnvelope(evidence);
  await appendStockEventTx(tx, siteId, event, event.localRevisionId);
}

/** Plan batch 3: a transfer revision approved or rejected on the LAN; no-op off the LAN primary. */
export async function capturePhase9StockTransferRevisionReviewTx(
  tx: DbTransaction,
  evidence: Omit<Phase9StockTransferRevisionReviewEvidence, "localEditId">
): Promise<void> {
  const siteId = lanSiteId();
  if (!siteId) return;
  await appendStockFollowUpTx(tx, siteId, (localEditId) =>
    phase9StockTransferRevisionReviewEnvelope({ ...evidence, localEditId })
  );
}
