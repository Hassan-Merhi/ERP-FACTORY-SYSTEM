/**
 * Phase 9 cloud apply handler for `stock.transfer.v1`.
 *
 * Replays a stock transfer created on the factory LAN server through the same
 * code the live route uses (createStockTransferTx), on the SAME PostgreSQL
 * client/transaction as the Phase 9 receipt and cursor, keyed by the LAN
 * request id so it can never be created twice. The owner-approved policy: a
 * transfer that would take a cloud source location below zero is held as
 * PHASE9_STOCK_WOULD_GO_NEGATIVE until an Admin/Developer approves
 * (approve-override) or rejects it. Every other refusal can only be rejected.
 * The cloud allocates its own voucher number for the transfer.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import type { DbTransaction } from "../db";
import { toMoney } from "../lib/money";
import { createStockTransferTx } from "../services/inventory/createStockTransfer";
import { StockTransferPolicyError } from "../storage/stock-ops/transfers-create";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import { PHASE9_STOCK_NEGATIVE_CONFLICT, type Phase9StockTransferEvidence } from "./phase9StockEnvelope.mjs";
import { throwIfClosedPeriod } from "./phase9ClosedPeriod";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9StockTransferEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: { kind: string } & { [K in keyof Phase9StockTransferEvidence]: Phase9StockTransferEvidence[K] };
  payloadSha256: string;
}

export interface Phase9StockTransferApplyResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const READ_ONLY_ROLES = new Set(["View Only", "Create Only", "ERP Tester"]);

/** The live route needs an authenticated, writing member of the company; re-checked against CURRENT cloud access. */
async function authorize(client: Queryable, event: Phase9StockTransferEvent): Promise<void> {
  const access = await client.query(
    `SELECT u.active, r.role, r.pos_view_only
       FROM users u
       JOIN user_company_roles r ON r.user_id = u.id AND r.company_id = $2
      WHERE u.id = $1`,
    [event.actorUserId, event.companyId]
  );
  const row = access.rows[0];
  if (!row || row.active !== true) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ACCESS_REVOKED", { actorUserId: event.actorUserId });
  }
  if (row.pos_view_only === true || READ_ONLY_ROLES.has(String(row.role))) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", {
      actorUserId: event.actorUserId,
      role: String(row.role),
    });
  }
}

function lineKey(line: { sourceLocationId: number | null; stockItemId: number; quantity: string }) {
  return `${line.sourceLocationId}:${line.stockItemId}:${toMoney(line.quantity).toFixed()}`;
}

/** The cloud transfer carries exactly the LAN's lines and destination. */
function sameTransfer(
  p: Phase9StockTransferEvent["payload"],
  transfer: { destinationLocationId: number },
  lines: Array<{ sourceLocationId: number | null; stockItemId: number; quantity: string }>
) {
  if (Number(transfer.destinationLocationId) !== p.destinationLocationId || lines.length !== p.items.length) {
    return false;
  }
  const cloud = lines.map(lineKey).sort();
  const lan = p.items.map(lineKey).sort();
  return cloud.every((key, index) => key === lan[index]);
}

async function apply(
  client: Queryable,
  event: Phase9StockTransferEvent,
  context: { readonly overrideConflicts: readonly string[] } = { overrideConflicts: [] }
): Promise<Phase9StockTransferApplyResult> {
  const p = event.payload;
  const companyId = event.companyId;
  const sources = new Set(p.items.map((item) => item.sourceLocationId));
  if (sources.has(p.destinationLocationId)) {
    throw new Phase9EventConflict("PHASE9_STOCK_TRANSFER_INVALID", { reason: "source-equals-destination" });
  }
  const allowNegative = context.overrideConflicts.includes(PHASE9_STOCK_NEGATIVE_CONFLICT);
  let created;
  try {
    created = await createStockTransferTx(drizzle(client as PoolClient) as unknown as DbTransaction, {
      companyId,
      requestId: event.operationId,
      items: p.items,
      sourceLocationId: p.sourceLocationId,
      destinationLocationId: p.destinationLocationId,
      resolvedHeaderSourceId: sources.size === 1 ? [...sources][0] : null,
      effectiveDate: p.businessDate,
      notes: p.notes,
      optional: p.optional,
      // Owner policy: a cloud shortfall is held for review, whatever the LAN allowed.
      allowNegativeInventory: allowNegative,
      actorUserId: event.actorUserId,
    });
  } catch (error) {
    throwIfClosedPeriod(error);
    if (error instanceof StockTransferPolicyError) {
      if (error.code === "STOCK_TRANSFER_NEGATIVE_STOCK_DISABLED") {
        throw new Phase9EventConflict(PHASE9_STOCK_NEGATIVE_CONFLICT, { reason: error.message });
      }
      throw new Phase9EventConflict("PHASE9_STOCK_TRANSFER_SCOPE_INVALID", { reason: error.message });
    }
    throw error;
  }
  if (!sameTransfer(p, created.transfer, created.transferItems)) {
    throw new Phase9EventConflict("PHASE9_STOCK_REQUEST_ID_DIVERGED", { cloudTransferId: created.transfer.id });
  }
  return {
    outcome: created.replayed ? "already-present" : "cloud-applied",
    cloudRef: created.transfer.id,
    businessDate: p.businessDate,
  };
}

async function verify(
  client: Queryable,
  event: Phase9StockTransferEvent,
  result: Phase9StockTransferApplyResult
): Promise<boolean> {
  const transfer = await client.query(
    `SELECT t.destination_location_id AS "destinationLocationId"
       FROM stock_transfer_vouchers t JOIN vouchers v ON v.id = t.voucher_id
      WHERE t.id = $1 AND v.company_id = $2`,
    [result.cloudRef, event.companyId]
  );
  if (transfer.rows.length !== 1) return false;
  const lines = await client.query(
    `SELECT source_location_id AS "sourceLocationId", stock_item_id AS "stockItemId", quantity::text AS quantity
       FROM stock_transfer_items WHERE transfer_id = $1`,
    [result.cloudRef]
  );
  return sameTransfer(event.payload, transfer.rows[0], lines.rows);
}

export const phase9StockTransferApplyHandler = Object.freeze({ authorize, apply, verify });
