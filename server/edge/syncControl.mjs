/**
 * Phase 10 operator control: pause / resume LAN -> cloud delivery.
 *
 * An append-only log; the latest row wins. Pausing never deletes, rewrites or
 * reorders local evidence — it only stops the relay from transmitting, so an
 * operator can freeze delivery during a cloud incident, restore or handover.
 * With no rows the relay is allowed (the relay is itself opt-in by env).
 */
const ACTIONS = new Set(["pause", "resume"]);

export class Phase10ControlRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase10ControlRefusal";
  }
}

export async function readPhase10SyncControl(queryable, siteId) {
  const result = await queryable.query(
    `SELECT action, operator_name, reason, recorded_at
       FROM factory_edge_sync_control_log
      WHERE site_id = $1::uuid
      ORDER BY id DESC LIMIT 1`,
    [siteId]
  );
  const row = result.rows[0];
  if (!row) return { paused: false, operatorName: null, reason: null, recordedAt: null };
  return {
    paused: row.action === "pause",
    operatorName: String(row.operator_name),
    reason: String(row.reason),
    recordedAt: new Date(row.recorded_at).toISOString(),
  };
}

export async function recordPhase10SyncControl(queryable, input) {
  if (
    !input ||
    !ACTIONS.has(input.action) ||
    typeof input.siteId !== "string" ||
    typeof input.operatorName !== "string" ||
    input.operatorName.trim().length < 3 ||
    typeof input.reason !== "string" ||
    input.reason.trim().length < 10
  ) {
    throw new Phase10ControlRefusal("PHASE10_SYNC_CONTROL_INVALID");
  }
  await queryable.query(
    `INSERT INTO factory_edge_sync_control_log (site_id, action, operator_name, reason)
     VALUES ($1::uuid, $2, $3, $4)`,
    [input.siteId, input.action, input.operatorName.trim(), input.reason.trim()]
  );
  return readPhase10SyncControl(queryable, input.siteId);
}
