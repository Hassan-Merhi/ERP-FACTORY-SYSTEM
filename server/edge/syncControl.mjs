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

export async function ensurePhase10SyncControlSchema(queryable) {
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS factory_edge_sync_control_log (
      id BIGSERIAL PRIMARY KEY,
      site_id UUID NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('pause', 'resume')),
      operator_name TEXT NOT NULL CHECK (length(btrim(operator_name)) >= 3),
      reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 10),
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )
  `);
  await queryable.query(`
    CREATE OR REPLACE FUNCTION factory_edge_sync_control_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'PHASE10_SYNC_CONTROL_IMMUTABLE' USING ERRCODE = '23514';
    END $$
  `);
  await queryable.query(
    "DROP TRIGGER IF EXISTS factory_edge_sync_control_no_mutation ON factory_edge_sync_control_log"
  );
  await queryable.query(`
    CREATE TRIGGER factory_edge_sync_control_no_mutation
    BEFORE UPDATE OR DELETE ON factory_edge_sync_control_log
    FOR EACH ROW EXECUTE FUNCTION factory_edge_sync_control_immutable()
  `);
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
