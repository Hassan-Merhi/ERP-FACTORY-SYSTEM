/**
 * Stock Transfer Order WhatsApp approval, Phase 1.
 *
 * This service only creates and validates immutable approval snapshots. It
 * deliberately does NOT approve revisions, change inventory, or send WhatsApp.
 * Phase 2 will call createDraft from the dedicated order-screen API; the
 * approval worker must call assertCurrent inside its approval transaction.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type DbTransaction } from "../db";

const MAX_ORDERS = 100;
const MAX_REVISIONS = 2000;

export class StockTransferOrderApprovalError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "StockTransferOrderApprovalError";
  }
}

type IdRow = { transfer_id: number; voucher_number: string };
type RevisionRow = {
  transfer_id: number;
  revision_id: number;
  revision_number: number;
  payload_hash: string | null;
};
type LineRow = {
  transfer_id: number;
  line_id: number;
  stock_item_id: number;
  source_location_id: number | null;
  quantity: string;
  rate: string;
  total_amount: string;
};

function fail(code: string, message: string): never {
  throw new StockTransferOrderApprovalError(code, message);
}

function safeIds(ids: readonly number[]): number[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ORDERS ||
      ids.some((v) => !Number.isSafeInteger(v) || v <= 0) ||
      new Set(ids).size !== ids.length) {
    fail("STO_WA_BAD_SELECTION", "Select 1–100 different Stock Transfer Orders.");
  }
  return [...ids].sort((a, b) => a - b);
}

function lineHashes(rows: readonly LineRow[]): Map<number, string> {
  const lines = new Map<number, string[]>();
  for (const row of rows) {
    const transferId = Number(row.transfer_id);
    const data = lines.get(transferId) ?? [];
    // Explicit ordering and string precision preserve accounting decimals.
    data.push(JSON.stringify([
      Number(row.line_id), Number(row.stock_item_id), Number(row.source_location_id ?? 0),
      String(row.quantity), String(row.rate), String(row.total_amount),
    ]));
    lines.set(transferId, data);
  }
  return new Map(
    [...lines].map(([id, values]) => [
      id, createHash("sha256").update(JSON.stringify(values)).digest("hex"),
    ])
  );
}

async function loadLines(tx: DbTransaction, transferIds: number[]): Promise<Map<number, string>> {
  const result = await tx.execute(sql`
    SELECT ti.transfer_id, ti.id AS line_id, ti.stock_item_id, ti.source_location_id,
           ti.quantity::text AS quantity, ti.rate::text AS rate,
           ti.total_amount::text AS total_amount
      FROM stock_transfer_items ti
     WHERE ti.transfer_id = ANY(${transferIds}::integer[])
     ORDER BY ti.transfer_id, ti.stock_item_id, ti.source_location_id, ti.id
  `);
  return lineHashes(result.rows as LineRow[]);
}

async function loadEligibleOrders(tx: DbTransaction, companyId: number, destinationId: number, transferIds: number[], lock: boolean) {
  const query = sql`
    SELECT t.id AS transfer_id, v.voucher_number
      FROM stock_transfer_vouchers t
      JOIN vouchers v ON v.id=t.voucher_id
     WHERE v.company_id=${companyId}
       AND v.deleted_at IS NULL
       AND v.voucher_type='Stock Transfer'
       AND t.workflow_origin='stock_transfer_order'
       AND t.destination_location_id=${destinationId}
       AND t.id=ANY(${transferIds}::integer[])
     ORDER BY t.id
  `;
  // Consistent lock order keeps concurrent batch creation serialized. The
  // immutable revision service also locks the stock_transfer_vouchers row.
  // Only the stock_transfer_vouchers row needs the approval serialization
  // lock. Locking the linked posted voucher adds an unnecessary financial-row
  // UPDATE lock and may hit stricter posted-voucher security/fiscal guards.
  // All voucher fields are still verified by the join and frozen snapshot.
  const result = await tx.execute(lock ? sql`${query} FOR UPDATE OF t` : query);
  return result.rows as IdRow[];
}

async function loadPendingRevisions(tx: DbTransaction, transferIds: number[]): Promise<RevisionRow[]> {
  const result = await tx.execute(sql`
    SELECT r.transfer_id, r.id AS revision_id, r.revision_number,
           r.payload_hash
      FROM stock_transfer_revisions r
     WHERE r.transfer_id=ANY(${transferIds}::integer[])
       AND r.status='pending'
     ORDER BY r.transfer_id, r.revision_number, r.id
  `);
  return result.rows as RevisionRow[];
}

export type CreateStockTransferOrderApprovalDraftInput = {
  companyId: number;
  destinationLocationId: number;
  transferIds: number[];
  actorUserId: string;
};

export type StockTransferOrderApprovalDraft = {
  batchId: number;
  batchKey: string;
  destinationLocationId: number;
  transferCount: number;
  revisionCount: number;
  approvalGroupChatId: string;
};

/**
 * Freeze the exact pending revisions and item quantities in one transaction.
 * No message is sent here. A single active reservation per transfer prevents
 * two live approval requests from racing to approve the same document.
 */
export async function createStockTransferOrderApprovalDraft(
  input: CreateStockTransferOrderApprovalDraftInput
): Promise<StockTransferOrderApprovalDraft> {
  const companyId = Number(input.companyId);
  const destinationId = Number(input.destinationLocationId);
  const ids = safeIds(input.transferIds);
  const actorId = String(input.actorUserId ?? "").trim();
  if (!Number.isSafeInteger(companyId) || companyId <= 0 ||
      !Number.isSafeInteger(destinationId) || destinationId <= 0 || !actorId || actorId.length > 255) {
    fail("STO_WA_INVALID_CONTEXT", "Company, destination and authenticated user are required.");
  }

  let failedStep = "transaction_start";
  try {
    return await db.transaction(async (tx) => {
    failedStep = "read_approval_settings";
    const config = await tx.execute(sql`
      SELECT enabled, approval_group_chat_id, authorized_phone_e164
        FROM stock_transfer_order_approval_settings
       WHERE company_id=${companyId}
       FOR SHARE
    `);
    const setting = config.rows[0] as {
      enabled: boolean; approval_group_chat_id: string | null; authorized_phone_e164: string | null
    } | undefined;
    if (!setting?.enabled || !setting.approval_group_chat_id || !setting.authorized_phone_e164) {
      fail("STO_WA_NOT_CONFIGURED", "Configure the approval WhatsApp group and authorized phone first.");
    }

    failedStep = "read_destination_recipient";
    const recipient = await tx.execute(sql`
      SELECT chat_id FROM stock_transfer_order_destination_recipients
       WHERE company_id=${companyId} AND destination_location_id=${destinationId} AND enabled=true
       FOR SHARE
    `);
    const recipientChatId = (recipient.rows[0] as { chat_id?: string } | undefined)?.chat_id;
    if (!recipientChatId) {
      fail("STO_WA_DESTINATION_NOT_CONFIGURED", "The destination has no enabled WhatsApp recipient.");
    }

    failedStep = "lock_and_read_eligible_orders";
    const orders = await loadEligibleOrders(tx, companyId, destinationId, ids, true);
    if (orders.length !== ids.length) {
      fail("STO_WA_SCOPE", "Only existing Stock Transfer Orders from the selected company and destination may be included.");
    }

    failedStep = "check_active_reservations";
    const conflicts = await tx.execute(sql`
      SELECT transfer_id FROM stock_transfer_order_approval_batch_items
       WHERE company_id=${companyId} AND transfer_id=ANY(${ids}::integer[])
         AND reservation_active=true
       LIMIT 1
    `);
    if (conflicts.rows.length) {
      fail("STO_WA_ALREADY_RESERVED", "An included order is already part of an active approval request.");
    }

    failedStep = "read_pending_revisions";
    const revisions = await loadPendingRevisions(tx, ids);
    if (!revisions.length) {
      fail("STO_WA_NO_REVISIONS", "The selected orders have no pending revisions to approve.");
    }
    if (revisions.length > MAX_REVISIONS) {
      fail("STO_WA_TOO_MANY_REVISIONS", "This request has too many revisions. Use a smaller batch.");
    }

    failedStep = "read_current_stock_transfer_lines";
    const hashes = await loadLines(tx, ids);
    if (orders.some((order) => !hashes.has(Number(order.transfer_id)))) {
      fail("STO_WA_EMPTY_ORDER", "Every selected order must contain stored stock lines.");
    }

    failedStep = "insert_batch_header";
    const inserted = await tx.execute(sql`
      INSERT INTO stock_transfer_order_approval_batches
        (company_id,destination_location_id,approval_group_chat_id,authorized_phone_e164,created_by,created_at)
      VALUES (${companyId},${destinationId},${setting.approval_group_chat_id},
              ${setting.authorized_phone_e164},${actorId},clock_timestamp())
      RETURNING id,batch_key
    `);
    const header = inserted.rows[0] as { id: number | string; batch_key: string };
    const batchId = Number(header.id);
    for (const order of orders) {
      failedStep = "insert_batch_order_item";
      await tx.execute(sql`
        INSERT INTO stock_transfer_order_approval_batch_items
          (company_id,batch_id,transfer_id,voucher_number_snapshot,item_hash_snapshot)
        VALUES (${companyId},${batchId},${Number(order.transfer_id)},
                ${String(order.voucher_number)},${hashes.get(Number(order.transfer_id))!})
      `);
    }
    for (const revision of revisions) {
      failedStep = "insert_batch_revision";
      await tx.execute(sql`
        INSERT INTO stock_transfer_order_approval_batch_revisions
          (company_id,batch_id,transfer_id,revision_id,revision_number_snapshot,payload_hash_snapshot)
        VALUES (${companyId},${batchId},${Number(revision.transfer_id)},
                ${Number(revision.revision_id)},${Number(revision.revision_number)},
                ${revision.payload_hash})
      `);
    }
    failedStep = "insert_draft_audit_event";
    await tx.execute(sql`
      INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details)
      VALUES (${companyId},${batchId},'draft_created',
              ${JSON.stringify({ destinationRecipientChatId: recipientChatId })}::jsonb)
    `);
    failedStep = "commit_snapshot_transaction";
    return {
      batchId,
      batchKey: String(header.batch_key),
      destinationLocationId: destinationId,
      transferCount: orders.length,
      revisionCount: revisions.length,
      approvalGroupChatId: setting.approval_group_chat_id,
    };
    });
  } catch (error) {
    if (error && typeof error === "object") {
      try { (error as { stoApprovalStep?: string }).stoApprovalStep = failedStep; } catch { /* preserve original database error */ }
    }
    throw error;
  }
}

export type StockTransferOrderApprovalSnapshot = {
  batchId: number;
  batchKey: string;
  transferIds: number[];
  revisionIds: number[];
  destinationLocationId: number;
  status: string;
};

/** Must be executed inside the same transaction that will later approve the revisions. */
export async function assertStockTransferOrderApprovalBatchCurrent(
  tx: DbTransaction,
  companyId: number,
  batchId: number
): Promise<StockTransferOrderApprovalSnapshot> {
  const headers = await tx.execute(sql`
    SELECT id,batch_key,destination_location_id,status,approval_group_chat_id,authorized_phone_e164,created_at
      FROM stock_transfer_order_approval_batches
     WHERE company_id=${companyId} AND id=${batchId}
     FOR UPDATE
  `);
  const header = headers.rows[0] as {
    id: number; batch_key: string; destination_location_id: number; status: string;
    approval_group_chat_id: string; authorized_phone_e164: string; created_at: Date
  } | undefined;
  if (!header || !["draft", "requested"].includes(header.status)) {
    fail("STO_WA_BATCH_INACTIVE", "This approval request is no longer pending.");
  }

  const snapshotItems = await tx.execute(sql`
    SELECT transfer_id,voucher_number_snapshot,item_hash_snapshot,reservation_active
      FROM stock_transfer_order_approval_batch_items
     WHERE company_id=${companyId} AND batch_id=${batchId}
     ORDER BY transfer_id
  `);
  const items = snapshotItems.rows as Array<{
    transfer_id: number; voucher_number_snapshot: string;
    item_hash_snapshot: string; reservation_active: boolean
  }>;
  if (!items.length || items.some((item) => !item.reservation_active)) {
    fail("STO_WA_BATCH_STALE", "The approval batch was released or has no selected orders.");
  }
  const ids = items.map((item) => Number(item.transfer_id));
  const orders = await loadEligibleOrders(tx, companyId, Number(header.destination_location_id), ids, true);
  if (orders.length !== ids.length ||
      orders.some((order, index) => String(order.voucher_number) !== items[index].voucher_number_snapshot)) {
    fail("STO_WA_BATCH_STALE", "An included order was changed, removed or moved to another destination.");
  }
  const currentHashes = await loadLines(tx, ids);
  if (items.some((item) => currentHashes.get(Number(item.transfer_id)) !== item.item_hash_snapshot)) {
    fail("STO_WA_BATCH_STALE", "Order contents changed since the WhatsApp approval request was created.");
  }

  const saved = await tx.execute(sql`
    SELECT revision_id,transfer_id,revision_number_snapshot,payload_hash_snapshot
      FROM stock_transfer_order_approval_batch_revisions
     WHERE company_id=${companyId} AND batch_id=${batchId}
     ORDER BY transfer_id,revision_number_snapshot,revision_id
  `);
  const frozen = (saved.rows as Array<{
    revision_id: number; transfer_id: number;
    revision_number_snapshot: number; payload_hash_snapshot: string | null
  }>).map((r) => [
    Number(r.transfer_id), Number(r.revision_id), Number(r.revision_number_snapshot), r.payload_hash_snapshot,
  ]);
  const current = (await loadPendingRevisions(tx, ids)).map((r) => [
    Number(r.transfer_id), Number(r.revision_id), Number(r.revision_number), r.payload_hash,
  ]);
  if (!frozen.length || JSON.stringify(frozen) !== JSON.stringify(current)) {
    fail("STO_WA_BATCH_STALE", "New, removed or superseded revisions require a refreshed approval request.");
  }

  // Changing or disabling the authorized phone/group invalidates old requests.
  const settings = await tx.execute(sql`
    SELECT enabled,approval_group_chat_id,authorized_phone_e164,
           (updated_at <= ${header.created_at}) AS unchanged
      FROM stock_transfer_order_approval_settings
     WHERE company_id=${companyId}
  `);
  const s = settings.rows[0] as {
    enabled: boolean; approval_group_chat_id: string | null; authorized_phone_e164: string | null; unchanged: boolean
  } | undefined;
  if (!s?.enabled || !s.unchanged ||
      s.approval_group_chat_id !== header.approval_group_chat_id ||
      s.authorized_phone_e164 !== header.authorized_phone_e164) {
    fail("STO_WA_AUTH_CHANGED", "Approval configuration changed. Send a new approval request.");
  }

  // Freeze the destination's second WhatsApp recipient in the immutable
  // draft_created event, and invalidate the request on ANY later routing edit.
  // Phase 5 must use this pinned recipient, never a silently changed setting.
  const audit = await tx.execute(sql`
    SELECT details->>'destinationRecipientChatId' AS destination_chat_id
      FROM stock_transfer_order_approval_events
     WHERE company_id=${companyId} AND batch_id=${batchId} AND event_type='draft_created'
     ORDER BY id LIMIT 1
  `);
  const frozenChatId = (audit.rows[0] as { destination_chat_id: string | null } | undefined)?.destination_chat_id;
  const destination = await tx.execute(sql`
    SELECT chat_id,enabled,(updated_at <= ${header.created_at}) AS unchanged
      FROM stock_transfer_order_destination_recipients
     WHERE company_id=${companyId}
       AND destination_location_id=${Number(header.destination_location_id)}
     FOR SHARE
  `);
  const currentDestination = destination.rows[0] as {
    chat_id: string; enabled: boolean; unchanged: boolean
  } | undefined;
  if (!frozenChatId || !currentDestination?.enabled || !currentDestination.unchanged ||
      currentDestination.chat_id !== frozenChatId) {
    fail("STO_WA_DESTINATION_CHANGED", "Destination WhatsApp recipient changed. Send a new approval request.");
  }

  return {
    batchId: Number(header.id),
    batchKey: String(header.batch_key),
    transferIds: ids,
    revisionIds: frozen.map((r) => Number(r[1])),
    destinationLocationId: Number(header.destination_location_id),
    status: header.status,
  };
}
