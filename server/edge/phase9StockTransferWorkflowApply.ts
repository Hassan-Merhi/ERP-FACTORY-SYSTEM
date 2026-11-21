/**
 * Phase 9 cloud apply handlers for plan batch 3 (owner-approved 2026-11-05):
 * changes to an existing stock transfer made on the factory LAN server
 * during an outage. They cover:
 * - stock.transfer-edit.v1 (PUT /api/stock-transfers/:id);
 * - stock.transfer-finalize.v1 (finalize / approve);
 * - stock.transfer-revision.v1 (a revision);
 * - stock.transfer-revision-review.v1 (approve or reject a revision).
 *
 * Each replays through the same service code as the live route, on the SAME
 * PostgreSQL client and transaction as the Phase 9 receipt and cursor, so it
 * applies exactly once.
 *
 * Owner rule: a change applies only while the cloud's copy still matches what
 * the factory saw. An edit or finalize of a transfer the cloud changed in the
 * meantime is held as PHASE9_STOCK_TRANSFER_CHANGED; Admin/Developer approve
 * (the factory's change wins) or reject it. A revision whose original
 * quantities no longer match is held with the same code, but can only be
 * rejected: the revision service refuses a stale revision whatever the
 * decision. Every other refusal is reject-only.
 */
import {
  approveImmutableStockTransferRevision,
  createImmutableStockTransferRevision,
  rejectImmutableStockTransferRevision,
} from "../services/immutableStockTransferRevisionLifecycle";
import { finalizeOptionalStockTransferTx } from "../services/stockTransferLifecycle";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import {
  PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT,
  PHASE9_STOCK_TRANSFER_REVISION_KIND,
  phase9TransferSnapshot,
  type Phase9RevisionRef,
} from "./phase9StockTransferWorkflowEnvelope.mjs";
import { throwIfClosedPeriod } from "./phase9ClosedPeriod";
import {
  REVISION_STALE_CODES,
  txOf,
  authorizeActor,
  appliedCloudRef,
  cloudTransferId,
  cloudSnapshot,
  holdIfChanged,
  refusal,
  applyEdit,
  type Queryable,
  type Context,
  type Phase9StockTransferEditEvent,
  type Phase9StockTransferFinalizeEvent,
  type Phase9StockTransferRevisionEvent,
  type Phase9StockTransferRevisionReviewEvent,
  type Phase9StockTransferWorkflowResult,
} from "./phase9StockTransferWorkflowApplyHelpers";
export type {
  Phase9StockTransferEditEvent,
  Phase9StockTransferFinalizeEvent,
  Phase9StockTransferRevisionEvent,
  Phase9StockTransferRevisionReviewEvent,
  Phase9StockTransferWorkflowResult,
} from "./phase9StockTransferWorkflowApplyHelpers";

async function cloudRevisionId(
  client: Queryable,
  siteId: string,
  companyId: number,
  ref: Phase9RevisionRef
): Promise<number> {
  const id =
    ref.origin === "lan"
      ? await appliedCloudRef(client, siteId, companyId, PHASE9_STOCK_TRANSFER_REVISION_KIND, ref.localRevisionId)
      : ref.revisionId;
  const owned =
    id === null
      ? null
      : await client.query(
          `SELECT r.id FROM stock_transfer_revisions r
             JOIN stock_transfer_vouchers t ON t.id = r.transfer_id JOIN vouchers v ON v.id = t.voucher_id
            WHERE r.id = $1 AND v.company_id = $2`,
          [id, companyId]
        );
  if (id === null || !owned?.rows.length) {
    throw new Phase9EventConflict("PHASE9_STOCK_TRANSFER_REVISION_MISSING", { revision: ref });
  }
  return id;
}

function sortedLines(items: ReadonlyArray<{ sourceLocationId: number; stockItemId: number; quantity: number }>) {
  return phase9TransferSnapshot({ destinationLocationId: 0, optional: false, inventoryApplied: false }, items).lines;
}

// ---- stock.transfer-edit.v1 -------------------------------------------------

async function verifyEdit(
  client: Queryable,
  event: Phase9StockTransferEditEvent,
  result: Phase9StockTransferWorkflowResult
): Promise<boolean> {
  const now = await cloudSnapshot(client, event.companyId, result.cloudRef);
  // Lines are merged by (source, item) on save, so compare against the merged target.
  const merged = new Map<string, { sourceLocationId: number; stockItemId: number; quantity: number }>();
  for (const item of event.payload.after.items) {
    const key = `${item.sourceLocationId}:${item.stockItemId}`;
    const prior = merged.get(key);
    merged.set(key, { ...item, quantity: (prior?.quantity ?? 0) + item.quantity });
  }
  return (
    now.destinationLocationId === event.payload.after.destinationLocationId &&
    JSON.stringify(now.lines) === JSON.stringify(sortedLines([...merged.values()]))
  );
}

// ---- stock.transfer-finalize.v1 ---------------------------------------------

async function applyFinalize(
  client: Queryable,
  event: Phase9StockTransferFinalizeEvent,
  context: Context
): Promise<Phase9StockTransferWorkflowResult> {
  const p = event.payload;
  const transferId = await cloudTransferId(client, context.siteId, event.companyId, p.transfer);
  const current = await cloudSnapshot(client, event.companyId, transferId);
  if (!current.optional && current.inventoryApplied) {
    return { outcome: "already-present", cloudRef: transferId, businessDate: p.businessDate };
  }
  holdIfChanged(p.before, current, context);
  try {
    await finalizeOptionalStockTransferTx(txOf(client), event.companyId, current.voucherId);
  } catch (error) {
    refusal(error, "PHASE9_STOCK_TRANSFER_FINALIZE_REFUSED");
  }
  return { outcome: "cloud-applied", cloudRef: transferId, businessDate: p.businessDate };
}

async function verifyFinalize(
  client: Queryable,
  event: Phase9StockTransferFinalizeEvent,
  result: Phase9StockTransferWorkflowResult
): Promise<boolean> {
  const now = await cloudSnapshot(client, event.companyId, result.cloudRef);
  return !now.optional && now.inventoryApplied;
}

// ---- stock.transfer-revision.v1 ---------------------------------------------

function revisionRefusal(error: unknown): never {
  throwIfClosedPeriod(error);
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (REVISION_STALE_CODES.has(code)) {
    throw new Phase9EventConflict(PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT, {
      reason: (error as Error).message,
      code,
    });
  }
  if (code === "STOCK_TRANSFER_REVISION_STATUS") {
    throw new Phase9EventConflict("PHASE9_STOCK_TRANSFER_REVISION_STATUS", { reason: (error as Error).message });
  }
  refusal(error, "PHASE9_STOCK_TRANSFER_REVISION_REFUSED");
}

async function applyRevision(
  client: Queryable,
  event: Phase9StockTransferRevisionEvent,
  context: Context
): Promise<Phase9StockTransferWorkflowResult> {
  const p = event.payload;
  const transferId = await cloudTransferId(client, context.siteId, event.companyId, p.transfer);
  let revisionId: number;
  try {
    const created = await createImmutableStockTransferRevision(
      {
        companyId: event.companyId,
        transferId,
        userId: event.actorUserId,
        note: p.revision.note,
        pending: p.revision.pending,
        sourceLocationIdLimit: p.revision.sourceLocationIdLimit,
        items: p.revision.items,
      },
      undefined,
      txOf(client)
    );
    revisionId = created.revisionId;
  } catch (error) {
    revisionRefusal(error);
  }
  return { outcome: "cloud-applied", cloudRef: revisionId, businessDate: p.businessDate };
}

async function verifyRevision(
  client: Queryable,
  event: Phase9StockTransferRevisionEvent,
  result: Phase9StockTransferWorkflowResult
): Promise<boolean> {
  const found = await client.query(
    `SELECT count(*)::int AS lines FROM stock_transfer_revisions r
       JOIN stock_transfer_revision_items i ON i.revision_id = r.id
      WHERE r.id = $1 AND r.created_by = $2`,
    [result.cloudRef, event.actorUserId]
  );
  return Number(found.rows[0]?.lines ?? 0) >= 1;
}

// ---- stock.transfer-revision-review.v1 --------------------------------------

async function applyReview(
  client: Queryable,
  event: Phase9StockTransferRevisionReviewEvent,
  context: Context
): Promise<Phase9StockTransferWorkflowResult> {
  const p = event.payload;
  const revisionId = await cloudRevisionId(client, context.siteId, event.companyId, p.revision);
  let transition: string;
  try {
    const reviewed =
      p.decision === "approve"
        ? await approveImmutableStockTransferRevision(
            event.companyId,
            revisionId,
            event.actorUserId,
            undefined,
            txOf(client)
          )
        : await rejectImmutableStockTransferRevision(
            event.companyId,
            revisionId,
            event.actorUserId,
            p.reason,
            undefined,
            txOf(client)
          );
    transition = reviewed.transition;
  } catch (error) {
    revisionRefusal(error);
  }
  return {
    outcome: transition === "no-op" ? "already-present" : "cloud-applied",
    cloudRef: revisionId,
    businessDate: p.businessDate,
  };
}

async function verifyReview(
  client: Queryable,
  event: Phase9StockTransferRevisionReviewEvent,
  result: Phase9StockTransferWorkflowResult
): Promise<boolean> {
  const found = await client.query("SELECT status FROM stock_transfer_revisions WHERE id = $1", [result.cloudRef]);
  return found.rows[0]?.status === (event.payload.decision === "approve" ? "approved" : "rejected");
}

// The live routes: PUT edit and revision create need an authenticated writing
// member (POS allowed); finalize and revision review are non-POS and need the
// act_transfer_stock action.
export const phase9StockTransferEditApplyHandler = Object.freeze({
  authorize: (client: Queryable, event: Phase9StockTransferEditEvent) =>
    authorizeActor(client, event, { nonPos: false }),
  apply: applyEdit,
  verify: verifyEdit,
});
export const phase9StockTransferFinalizeApplyHandler = Object.freeze({
  authorize: (client: Queryable, event: Phase9StockTransferFinalizeEvent) =>
    authorizeActor(client, event, { nonPos: true, action: "act_transfer_stock" }),
  apply: applyFinalize,
  verify: verifyFinalize,
});
export const phase9StockTransferRevisionApplyHandler = Object.freeze({
  authorize: (client: Queryable, event: Phase9StockTransferRevisionEvent) =>
    authorizeActor(client, event, { nonPos: false }),
  apply: applyRevision,
  verify: verifyRevision,
});
export const phase9StockTransferRevisionReviewApplyHandler = Object.freeze({
  authorize: (client: Queryable, event: Phase9StockTransferRevisionReviewEvent) =>
    authorizeActor(client, event, { nonPos: true, action: "act_transfer_stock" }),
  apply: applyReview,
  verify: verifyReview,
});
