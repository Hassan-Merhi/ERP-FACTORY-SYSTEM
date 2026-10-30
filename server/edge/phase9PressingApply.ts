/**
 * Phase 9 cloud apply handler for `pressing.confirmation.v1`.
 *
 * Reproduces exactly what POST /api/factory/pressing-machines/confirm writes
 * (session, confirmation, optional RECONFIRM correction, audit) on the SAME
 * PostgreSQL client/transaction as the Phase 9 receipt and cursor advance.
 * Cloud master data is never rewritten to match the LAN: any disagreement is
 * raised as a Phase9EventConflict for a named operator decision.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { logAudit } from "../routes/helpers/auditHelpers";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9PressingEvent {
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
    localConfirmationId: number;
    baleId: number;
    machineId: number;
    assignmentId: number;
    referenceNumber: string;
    confirmedAt: string;
    deviceCapturedAt: string | null;
    productionDate: string;
    timezoneName: string;
  };
  payloadSha256: string;
}

export interface Phase9PressingApplyResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const READ_ONLY_ROLES = new Set(["View Only", "ERP Tester"]);

/** Same rule as the live route, evaluated against CURRENT cloud membership. */
async function authorize(client: Queryable, event: Phase9PressingEvent): Promise<void> {
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

async function apply(client: Queryable, event: Phase9PressingEvent): Promise<Phase9PressingApplyResult> {
  const p = event.payload;
  const companyId = event.companyId;
  const userId = event.actorUserId;
  // Same lock ordering as the live route: user, then machine, then assignment.
  await client.query("SELECT pg_advisory_xact_lock($1::integer, hashtext($2))", [companyId, userId]);

  const byRequest = await client.query(
    `SELECT id, bale_id, machine_id, assignment_id, user_id, reference_number,
            voided_at, production_date::text AS production_date
       FROM factory_pressing_confirmations
      WHERE company_id = $1 AND request_id = $2`,
    [companyId, event.operationId]
  );
  if (byRequest.rows.length) {
    const prior = byRequest.rows[0];
    const same =
      Number(prior.bale_id) === p.baleId &&
      Number(prior.machine_id) === p.machineId &&
      Number(prior.assignment_id) === p.assignmentId &&
      String(prior.user_id) === userId &&
      String(prior.reference_number) === p.referenceNumber &&
      String(prior.production_date) === p.productionDate &&
      prior.voided_at === null;
    if (!same) {
      throw new Phase9EventConflict("PHASE9_PRESSING_REQUEST_ID_DIVERGED", { cloudConfirmationId: prior.id });
    }
    return { outcome: "already-present", cloudRef: Number(prior.id), businessDate: String(prior.production_date) };
  }

  const machine = await client.query(
    "SELECT id, name FROM factory_pressing_machines WHERE company_id = $1 AND id = $2 FOR UPDATE",
    [companyId, p.machineId]
  );
  if (!machine.rows.length) {
    throw new Phase9EventConflict("PHASE9_PRESSING_MACHINE_MISSING", { machineId: p.machineId });
  }
  // The assignment must be the same one the LAN accepted. It may have been
  // ended since; the historical confirmation still belongs to it.
  const assignment = await client.query(
    `SELECT id FROM factory_pressing_assignments
      WHERE company_id = $1 AND id = $2 AND machine_id = $3 AND user_id = $4 FOR UPDATE`,
    [companyId, p.assignmentId, p.machineId, userId]
  );
  if (!assignment.rows.length) {
    throw new Phase9EventConflict("PHASE9_PRESSING_ASSIGNMENT_MISSING", { assignmentId: p.assignmentId });
  }
  const bale = await client.query(
    `SELECT id, reference_number, article_code, product_name, weight_kg::text AS weight_kg,
            status, deleted_at
       FROM factory_bales WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, p.baleId]
  );
  const baleRow = bale.rows[0];
  if (!baleRow || baleRow.deleted_at !== null || baleRow.status === "DELETED") {
    throw new Phase9EventConflict("PHASE9_PRESSING_BALE_MISSING", { baleId: p.baleId });
  }
  if (String(baleRow.reference_number) !== p.referenceNumber) {
    throw new Phase9EventConflict("PHASE9_PRESSING_BALE_REFERENCE_DIVERGED", {
      baleId: p.baleId,
      cloudReference: String(baleRow.reference_number),
    });
  }
  const active = await client.query(
    `SELECT id, request_id, confirmed_at
       FROM factory_pressing_confirmations
      WHERE company_id = $1 AND bale_id = $2 AND voided_at IS NULL`,
    [companyId, p.baleId]
  );
  if (active.rows.length) {
    throw new Phase9EventConflict("PHASE9_PRESSING_ALREADY_CONFIRMED", {
      cloudConfirmationId: Number(active.rows[0].id),
      cloudRequestId: String(active.rows[0].request_id),
      cloudConfirmedAt: new Date(active.rows[0].confirmed_at).toISOString(),
    });
  }

  const profile = await client.query(
    "SELECT display_name FROM factory_user_profiles WHERE company_id = $1 AND user_id = $2 LIMIT 1",
    [companyId, userId]
  );
  const operator = await client.query("SELECT username FROM users WHERE id = $1", [userId]);
  const displayName = String(profile.rows[0]?.display_name ?? "").trim() || "Display name not set";

  // Reuse the operator's session for this exact machine/assignment, or add a
  // closed replay session so no open-session constraint is disturbed.
  const session = await client.query(
    `SELECT id FROM factory_pressing_sessions
      WHERE company_id = $1 AND user_id = $2 AND machine_id = $3 AND assignment_id = $4
      ORDER BY (ended_at IS NULL) DESC, id DESC LIMIT 1`,
    [companyId, userId, p.machineId, p.assignmentId]
  );
  const sessionId = session.rows.length
    ? Number(session.rows[0].id)
    : Number(
        (
          await client.query(
            `INSERT INTO factory_pressing_sessions
               (company_id, user_id, machine_id, assignment_id, shift_id, started_at, ended_at)
             VALUES ($1, $2, $3, $4, NULL, $5::timestamptz, $5::timestamptz)
             RETURNING id`,
            [companyId, userId, p.machineId, p.assignmentId, p.confirmedAt]
          )
        ).rows[0].id
      );

  const created = await client.query(
    `INSERT INTO factory_pressing_confirmations
       (company_id, bale_id, machine_id, assignment_id, session_id, shift_id, user_id,
        user_name_snapshot, machine_name_snapshot, reference_number, article_code,
        product_name, weight_kg, request_id, device_captured_at, confirmed_at,
        production_date, timezone_name)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, $11, $12::numeric, $13,
             $14::timestamptz, $15::timestamptz, $16::date, $17)
     RETURNING id`,
    [
      companyId,
      p.baleId,
      p.machineId,
      p.assignmentId,
      sessionId,
      userId,
      displayName,
      String(machine.rows[0].name),
      String(baleRow.reference_number),
      baleRow.article_code,
      baleRow.product_name,
      String(baleRow.weight_kg),
      event.operationId,
      p.deviceCapturedAt,
      p.confirmedAt,
      p.productionDate,
      p.timezoneName,
    ]
  );
  const confirmationId = Number(created.rows[0].id);

  // Mirror the route: a replacement after a supervisor void is linked.
  const voidedPrior = await client.query(
    `SELECT id, voided_by FROM factory_pressing_confirmations
      WHERE company_id = $1 AND bale_id = $2 AND voided_at IS NOT NULL
      ORDER BY voided_at DESC, id DESC LIMIT 1`,
    [companyId, p.baleId]
  );
  if (voidedPrior.rows[0]?.voided_by) {
    const original = await client.query(
      `SELECT id FROM factory_pressing_corrections
        WHERE company_id = $1 AND confirmation_id = $2 AND action = 'VOID'
        ORDER BY id DESC LIMIT 1`,
      [companyId, voidedPrior.rows[0].id]
    );
    await client.query(
      `INSERT INTO factory_pressing_corrections
         (company_id, confirmation_id, replacement_confirmation_id, action, reason, supervisor_user_id)
       VALUES ($1, $2, $3, 'RECONFIRM', $4, $5)`,
      [
        companyId,
        voidedPrior.rows[0].id,
        confirmationId,
        "Replacement pressing scan after supervisor void #" + (original.rows[0]?.id ?? voidedPrior.rows[0].id),
        voidedPrior.rows[0].voided_by,
      ]
    );
  }

  await logAudit(
    {
      userId,
      username: String(operator.rows[0]?.username ?? userId),
      companyId,
      action: "create",
      tableName: "factory_pressing_confirmations",
      recordId: confirmationId,
      recordIdentifier: p.referenceNumber,
      changes: {
        machineId: { old: null, new: p.machineId },
        assignmentId: { old: null, new: p.assignmentId },
        pressedAt: { old: null, new: p.confirmedAt },
        factoryLanOperationId: { old: null, new: event.operationId },
      },
    },
    drizzle(client as PoolClient)
  );
  return { outcome: "cloud-applied", cloudRef: confirmationId, businessDate: p.productionDate };
}

async function verify(
  client: Queryable,
  event: Phase9PressingEvent,
  result: Phase9PressingApplyResult
): Promise<boolean> {
  const p = event.payload;
  const check = await client.query(
    `SELECT 1 FROM factory_pressing_confirmations
      WHERE id = $1 AND company_id = $2 AND request_id = $3 AND bale_id = $4
        AND machine_id = $5 AND assignment_id = $6 AND user_id = $7
        AND voided_at IS NULL AND production_date = $8::date`,
    [
      result.cloudRef,
      event.companyId,
      event.operationId,
      p.baleId,
      p.machineId,
      p.assignmentId,
      event.actorUserId,
      result.businessDate,
    ]
  );
  return check.rows.length === 1;
}

export const phase9PressingApplyHandler = Object.freeze({ authorize, apply, verify });
