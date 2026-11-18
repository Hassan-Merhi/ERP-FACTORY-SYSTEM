// Full offline mode (Phase B): delivering the entries made on this PC while offline.
//
// Each entry recorded by the local server (pc_local.outbox) goes to the cloud's
// offline apply path (/api/offline/pc-sync/operations, the browser-sync path
// plus the owner's negative-stock rule: applied and flagged), which applies it
// exactly once as the signed-in user, refuses a changed replay, and reports a
// conflict instead of overwriting cloud data. Only an Admin or Developer can
// approve a conflict. Entries are delivered in the order they were made, only
// for the person whose cloud session the PC holds; anyone else's wait until
// they connect this PC.
//
// Once nothing is left to deliver, the PC undoes its own local writes and pulls
// the feed, which brings back the cloud's version of every delivered entry.

import { createHash } from "node:crypto";
import { PcSyncAgentError, syncOnce } from "./syncAgent.mjs";
import {
  PC_LOCAL_ENTRY_LOCK,
  countLocalWrites,
  inApplyTransaction,
  readLocalState,
  revertLocalWrites,
} from "./localStore.mjs";

const OUTSTANDING = ["capturing", "unconfirmed", "pending", "waiting"];
/** A save still "capturing" after this long was interrupted (no request lasts that long). */
const CAPTURE_STALE_MINUTES = 10;

/**
 * The device id the cloud sees for one person in one company on this PC. The
 * cloud binds a device id to the first user and company it serves, so each
 * pair gets its own, derived from the PC's id (stable across retries and
 * decisions, nothing to store).
 */
export function deliveryDeviceId(pcDeviceId, userId, companyId) {
  const h = createHash("sha256").update(`${pcDeviceId}|${userId}|${companyId}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Saves interrupted mid-request become "unconfirmed" for a person to decide. */
export async function markInterruptedCaptures(local) {
  const { rowCount } = await local.query(
    `UPDATE pc_local.outbox SET status = 'unconfirmed', updated_at = now()
      WHERE status = 'capturing' AND updated_at < now() - make_interval(mins => $1)`,
    [CAPTURE_STALE_MINUTES]
  );
  return rowCount ?? 0;
}

export async function outboxSummary(local) {
  const { rows } = await local.query(
    `SELECT status, user_id, count(*)::int AS n FROM pc_local.outbox
      WHERE status <> 'applied' GROUP BY status, user_id ORDER BY status, user_id`
  );
  return rows.map((r) => ({ status: r.status, userId: r.user_id, count: r.n }));
}

async function mark(local, id, status, { code = null, overridable = false, receipt = null } = {}) {
  await local.query(
    `UPDATE pc_local.outbox SET status = $2, code = $3, overridable = $4, receipt = $5::jsonb, updated_at = now()
      WHERE id = $1`,
    [id, status, code, overridable, receipt == null ? null : JSON.stringify(receipt)]
  );
}

/**
 * Delivers the connected person's outstanding entries, oldest first. Stops at
 * an entry that waits for an earlier one, and on any answer that means the
 * cloud cannot take entries now (signed out, switched off, server error).
 */
export async function deliverOutbox(local, cloud, { maxOperations = 200 } = {}) {
  const state = await readLocalState(local);
  const result = { applied: 0, conflicts: 0, refused: 0, waiting: false };
  if (!state.cloud_user_id) return result;
  const { rows } = await local.query(
    `SELECT id, operation_id, kind, input, local_ref, captured_at, company_id, user_id
       FROM pc_local.outbox
      WHERE status IN ('pending', 'waiting') AND user_id = $1
      ORDER BY id LIMIT $2`,
    [state.cloud_user_id, maxOperations]
  );
  let company = null;
  for (const op of rows) {
    if (op.company_id !== company) {
      const switched = await cloud.post("/api/auth/set-company", { companyId: op.company_id });
      if (switched.status === 401) throw new PcSyncAgentError("PC_SYNC_LOGIN_EXPIRED", { status: 401 });
      if (switched.status !== 200) {
        await mark(local, op.id, "refused", { code: "PC_SYNC_COMPANY_NOT_ALLOWED" });
        result.refused += 1;
        continue;
      }
      company = op.company_id;
    }
    const res = await cloud.post("/api/offline/pc-sync/operations", {
      deviceId: deliveryDeviceId(state.device_id, op.user_id, op.company_id),
      operationId: op.operation_id,
      kind: op.kind,
      localRef: op.local_ref,
      capturedAt: new Date(op.captured_at).toISOString(),
      input: op.input,
    });
    const code = res.body?.code ?? null;
    if (res.status === 200) {
      await mark(local, op.id, "applied", { receipt: res.body });
      result.applied += 1;
    } else if (res.status === 409) {
      await mark(local, op.id, "conflict", { code, overridable: res.body?.overridable === true });
      result.conflicts += 1;
    } else if (res.status === 202) {
      await mark(local, op.id, "waiting", { code });
      result.waiting = true;
      break;
    } else if (res.status === 400 || res.status === 403 || res.status === 422) {
      await mark(local, op.id, "refused", { code });
      result.refused += 1;
    } else if (res.status === 401) {
      throw new PcSyncAgentError("PC_SYNC_LOGIN_EXPIRED", { status: 401 });
    } else {
      throw new PcSyncAgentError(code || "PC_SYNC_DELIVERY_FAILED", { status: res.status });
    }
  }
  return result;
}

/**
 * One full cycle: deliver, then (when nothing is outstanding) undo the PC's own
 * writes and pull the cloud. While entries are outstanding the pull waits, so
 * the cloud's rows never mix with undelivered local ones.
 */
export async function syncCycle(local, cloud, options = {}) {
  await markInterruptedCaptures(local);
  const delivery = await deliverOutbox(local, cloud, options);
  // No entry may start while we check, undo and pull (the local server takes
  // the same lock, shared, for every entry it records).
  await local.query("SELECT pg_advisory_lock($1)", [PC_LOCAL_ENTRY_LOCK]);
  try {
    const { rows } = await local.query(
      "SELECT count(*)::int AS n FROM pc_local.outbox WHERE status = ANY($1::text[])",
      [OUTSTANDING]
    );
    let reverted = 0;
    if (rows[0].n === 0) reverted = await inApplyTransaction(local, () => revertLocalWrites(local));
    if ((await countLocalWrites(local)) > 0) {
      return { delivery, reverted, pullPaused: true, outstanding: rows[0].n, upToDate: false };
    }
    const report = await syncOnce(local, cloud, options);
    return { delivery, reverted, pullPaused: false, outstanding: 0, ...report };
  } finally {
    await local.query("SELECT pg_advisory_unlock($1)", [PC_LOCAL_ENTRY_LOCK]);
  }
}

/**
 * An entry whose save was interrupted: "send" delivers it like any other (the
 * person confirms they made it), "discard" drops it without contacting the
 * cloud. Anyone at the PC may decide; it is their own unsent entry.
 */
export async function decideUnconfirmed(local, operationId, decision) {
  if (decision !== "send" && decision !== "discard") throw new PcSyncAgentError("PC_SYNC_DECISION_INVALID");
  const { rowCount } = await local.query(
    `UPDATE pc_local.outbox
        SET status = $2, code = $3, updated_at = now(),
            local_ref = COALESCE(local_ref, nextval('pc_local.local_ref_seq')::integer)
      WHERE operation_id = $1::uuid AND status = 'unconfirmed'`,
    [operationId, decision === "send" ? "pending" : "refused", decision === "send" ? null : "DISCARDED"]
  );
  if (rowCount !== 1) throw new PcSyncAgentError("PC_SYNC_ENTRY_NOT_UNCONFIRMED");
}

/**
 * A held entry decided on this PC. "approve" sends it again with the conflict
 * code as the override (the cloud applies it only when the signed-in person is
 * an Admin or Developer); "discard" records it as rejected on the cloud.
 */
export async function resolveConflict(local, cloud, operationId, decision) {
  if (decision !== "approve" && decision !== "discard") throw new PcSyncAgentError("PC_SYNC_DECISION_INVALID");
  const state = await readLocalState(local);
  const { rows } = await local.query(
    `SELECT id, operation_id, kind, input, local_ref, captured_at, company_id, code, overridable, user_id
       FROM pc_local.outbox WHERE operation_id = $1::uuid AND status = 'conflict'`,
    [operationId]
  );
  const op = rows[0];
  if (!op) throw new PcSyncAgentError("PC_SYNC_CONFLICT_NOT_FOUND");
  if (decision === "approve" && !op.overridable) throw new PcSyncAgentError("PC_SYNC_CONFLICT_NOT_OVERRIDABLE");
  const switched = await cloud.post("/api/auth/set-company", { companyId: op.company_id });
  if (switched.status !== 200) throw new PcSyncAgentError("PC_SYNC_COMPANY_NOT_ALLOWED", { status: switched.status });
  const body = {
    deviceId: deliveryDeviceId(state.device_id, op.user_id, op.company_id),
    operationId: op.operation_id,
    kind: op.kind,
    localRef: op.local_ref,
    capturedAt: new Date(op.captured_at).toISOString(),
    input: op.input,
    ...(decision === "approve" ? { override: op.code } : {}),
  };
  const path =
    decision === "approve" ? "/api/offline/pc-sync/operations" : "/api/offline/browser-sync/operations/discard";
  const res = await cloud.post(path, body);
  if (res.status !== 200) {
    throw new PcSyncAgentError(res.body?.code || "PC_SYNC_DECISION_REFUSED", { status: res.status });
  }
  await mark(local, op.id, decision === "approve" ? "applied" : "refused", {
    code: decision === "approve" ? null : "DISCARDED",
    receipt: res.body,
  });
  return res.body;
}
