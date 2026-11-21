/**
 * Phase 9: atomic LAN evidence for stock movements (inventory quick adjust).
 * Its own gapless sequence and cloud cursors ("stock" stream), separate from
 * vouchers and pressing, so a held stock movement never blocks other streams.
 *
 * Delivery is the generic Phase 9 event stream: the LAN relay
 * (scripts/edge/relay-event-outbox.mjs) stages these rows in the cloud and the
 * operator apply (server/edge/phase9OperatorApply.ts) replays each movement
 * exactly once as a quantity delta. The schema is defined by migrations/ and
 * never created at runtime; without it the LAN write guard refuses the route
 * instead of failing mid-adjustment.
 */
import { capturePcLocalEnvelopeTx, isPcLocalId, pcLocalEntryMode } from "../offline/pcLocal/pcCapture";
import { sql } from "drizzle-orm";
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
  phase9StockItemDeleteEnvelope,
  type Phase9StockItemDeleteEvidence,
} from "./phase9StockItemLifecycleEnvelope.mjs";
import {
  PHASE9_STOCK_TRANSFER_REVISION_KIND,
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
import { appendStockEventTx, appendStockFollowUpTx, pcLocalFollowUpTx } from "./phase9StockOutboxHelpers.ts";
import { lanSiteId, recordedOnLanTx } from "./phase9StockOutboxHelpers2.ts";
export { capturePhase9StockItemCreateTx } from "./phase9StockOutboxHelpers2.ts";

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
 * outbox order lock. On a PC in entry mode it goes to the PC's outbox. No-op
 * elsewhere.
 */
export async function capturePhase9StockItemEditTx(
  tx: DbTransaction,
  evidence: Omit<Phase9StockItemEditEvidence, "localEditId">
): Promise<void> {
  // A PC in entry mode: the finished envelope goes to its own outbox, with a
  // local reference from the PC's sequence, in this transaction.
  if (pcLocalEntryMode()) {
    await pcLocalFollowUpTx(tx, (localEditId) => phase9StockItemEditEnvelope({ ...evidence, localEditId }));
    return;
  }
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

/** Plan batch 2: a stock item deleted (soft) on the LAN primary or a PC in entry mode; no-op elsewhere. */
export async function capturePhase9StockItemDeleteTx(
  tx: DbTransaction,
  evidence: Phase9StockItemDeleteEvidence
): Promise<void> {
  if (pcLocalEntryMode()) {
    const event = phase9StockItemDeleteEnvelope(evidence);
    await capturePcLocalEnvelopeTx(tx, event, event.stockItemId);
    return;
  }
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

/** How an offline record names a transfer: by its LAN record if created offline, else by its shared id. */
export async function phase9TransferRefTx(tx: DbTransaction, transferId: number): Promise<Phase9TransferRef> {
  const siteId = lanSiteId();
  // On a PC, a transfer made there carries a local id (the PC keeps it as the create's reference).
  if (pcLocalEntryMode()) {
    return isPcLocalId(transferId) ? { origin: "lan", localTransferId: transferId } : { origin: "cloud", transferId };
  }
  if (siteId && (await recordedOnLanTx(tx, siteId, "stock.transfer.v1", transferId))) {
    return { origin: "lan", localTransferId: transferId };
  }
  return { origin: "cloud", transferId };
}

/** How an offline record names a transfer revision (same rule as transfers). */
export async function phase9RevisionRefTx(tx: DbTransaction, revisionId: number): Promise<Phase9RevisionRef> {
  const siteId = lanSiteId();
  if (pcLocalEntryMode()) {
    return isPcLocalId(revisionId) ? { origin: "lan", localRevisionId: revisionId } : { origin: "cloud", revisionId };
  }
  if (siteId && (await recordedOnLanTx(tx, siteId, PHASE9_STOCK_TRANSFER_REVISION_KIND, revisionId))) {
    return { origin: "lan", localRevisionId: revisionId };
  }
  return { origin: "cloud", revisionId };
}

/** The transfer as it stands, locked for the rest of the transaction; null if it does not exist. */
export async function phase9TransferSnapshotTx(
  tx: DbTransaction,
  companyId: number,
  transferId: number
): Promise<Phase9TransferSnapshot | null> {
  const header = await tx.execute(sql`
    SELECT t.destination_location_id AS "destinationLocationId", t.source_location_id AS "headerSourceId",
           t.inventory_applied AS "inventoryApplied", v.optional
      FROM stock_transfer_vouchers t JOIN vouchers v ON v.id = t.voucher_id
     WHERE t.id = ${transferId} AND v.company_id = ${companyId}
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
  if (pcLocalEntryMode())
    return pcLocalFollowUpTx(tx, (localEditId) => phase9StockTransferEditEnvelope({ ...evidence, localEditId }));
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
  if (pcLocalEntryMode())
    return pcLocalFollowUpTx(tx, (localEditId) => phase9StockTransferFinalizeEnvelope({ ...evidence, localEditId }));
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
  const event = phase9StockTransferRevisionEnvelope(evidence);
  if (pcLocalEntryMode()) return capturePcLocalEnvelopeTx(tx, event, event.localRevisionId);
  const siteId = lanSiteId();
  if (!siteId) return;
  await appendStockEventTx(tx, siteId, event, event.localRevisionId);
}

/** Plan batch 3: a transfer revision approved or rejected on the LAN; no-op off the LAN primary. */
export async function capturePhase9StockTransferRevisionReviewTx(
  tx: DbTransaction,
  evidence: Omit<Phase9StockTransferRevisionReviewEvidence, "localEditId">
): Promise<void> {
  if (pcLocalEntryMode())
    return pcLocalFollowUpTx(tx, (localEditId) =>
      phase9StockTransferRevisionReviewEnvelope({ ...evidence, localEditId })
    );
  const siteId = lanSiteId();
  if (!siteId) return;
  await appendStockFollowUpTx(tx, siteId, (localEditId) =>
    phase9StockTransferRevisionReviewEnvelope({ ...evidence, localEditId })
  );
}
