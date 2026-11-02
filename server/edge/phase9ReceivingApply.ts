/**
 * Phase 9 cloud apply handler for `receiving.container-offload.v1`.
 *
 * Replays a factory LAN receipt of a container against its existing purchase
 * orders through the same offload lifecycle the live route uses, on the SAME
 * PostgreSQL transaction as the Phase 9 receipt and cursor. Quantities only:
 * no duties or charges, and the cloud's current purchase order prices value
 * the stock. If the order's quantities changed in the cloud during the outage
 * the receipt is held (PHASE9_RECEIVING_ORDER_CHANGED) for an Admin/Developer
 * to approve (receive the cloud's current quantities) or reject. A container
 * already offloaded or no longer offloadable can only be rejected.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import type { DbTransaction } from "../db";
import {
  ContainerOffloadLifecycleError,
  executeContainerOffloadLifecycleTx,
} from "../services/containers/offload-lifecycle";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import { PHASE9_RECEIVING_ORDER_CHANGED } from "./phase9ReceivingEnvelope.mjs";
import { phase9ReceivingLineDigestTx } from "./phase9ReceivingOutbox";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9ReceivingEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: {
    requestId: string;
    companyId: number;
    actorUserId: string;
    actorUsername: string;
    localOffloadId: number;
    containerId: number;
    locationId: number;
    offloadDate: string;
    lineDigest: string;
  };
  payloadSha256: string;
}

export interface Phase9ReceivingApplyResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const NOT_PERMITTED_ROLES = new Set(["View Only", "ERP Tester", "POS"]);

/** The live route is requireNonPOS; re-checked against CURRENT cloud access. */
async function authorize(client: Queryable, event: Phase9ReceivingEvent): Promise<void> {
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
  if (row.pos_view_only === true || NOT_PERMITTED_ROLES.has(String(row.role))) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", {
      actorUserId: event.actorUserId,
      role: String(row.role),
    });
  }
}

async function apply(
  client: Queryable,
  event: Phase9ReceivingEvent,
  context: { readonly overrideConflicts: readonly string[] } = { overrideConflicts: [] }
): Promise<Phase9ReceivingApplyResult> {
  const p = event.payload;
  const tx = drizzle(client as PoolClient) as unknown as DbTransaction;
  const container = await client.query("SELECT status FROM containers WHERE id = $1 AND company_id = $2 FOR UPDATE", [
    p.containerId,
    event.companyId,
  ]);
  if (!container.rows.length) {
    throw new Phase9EventConflict("PHASE9_RECEIVING_CONTAINER_MISSING", { containerId: p.containerId });
  }
  const status = String(container.rows[0].status);
  if (status === "OFFLOADED") {
    throw new Phase9EventConflict("PHASE9_RECEIVING_ALREADY_OFFLOADED", { containerId: p.containerId });
  }
  if (status !== "OTW") {
    throw new Phase9EventConflict("PHASE9_RECEIVING_CONTAINER_NOT_OFFLOADABLE", { containerId: p.containerId, status });
  }
  const cloudDigest = await phase9ReceivingLineDigestTx(tx, event.companyId, p.containerId);
  if (cloudDigest !== p.lineDigest && !context.overrideConflicts.includes(PHASE9_RECEIVING_ORDER_CHANGED)) {
    throw new Phase9EventConflict(PHASE9_RECEIVING_ORDER_CHANGED, {
      containerId: p.containerId,
      lanDigest: p.lineDigest,
      cloudDigest,
    });
  }
  try {
    const result = await executeContainerOffloadLifecycleTx(tx, {
      companyId: event.companyId,
      containerId: p.containerId,
      mode: "create-or-replace",
      locationId: p.locationId,
      offloadDate: p.offloadDate,
      duties: "0",
      officeCharges: "0",
      transferCharges: "0",
      transportFees: "0",
      additionalCharges: [],
      inventoryCostCorrections: [],
      agentChargeLines: [],
      actorRole: null,
    });
    return { outcome: "cloud-applied", cloudRef: Number(result.offload.id), businessDate: p.offloadDate };
  } catch (error) {
    if (error instanceof ContainerOffloadLifecycleError) {
      throw new Phase9EventConflict("PHASE9_RECEIVING_REFUSED", { code: error.code, status: error.status });
    }
    throw error;
  }
}

async function verify(
  client: Queryable,
  event: Phase9ReceivingEvent,
  result: Phase9ReceivingApplyResult
): Promise<boolean> {
  const check = await client.query(
    `SELECT 1 FROM container_offloads o JOIN containers c ON c.id = o.container_id
      WHERE o.id = $1 AND o.container_id = $2 AND c.company_id = $3 AND c.status = 'OFFLOADED'`,
    [result.cloudRef, event.payload.containerId, event.companyId]
  );
  return check.rows.length === 1;
}

export const phase9ReceivingApplyHandler = Object.freeze({ authorize, apply, verify });
