/**
 * Phase 9 cloud apply handler for pressing confirmations
 * (server/edge/phase9PressingApply.ts): current-membership authorization,
 * request-id replay and divergence, every master-data conflict, session
 * reuse versus a closed replay session, RECONFIRM linking after a supervisor
 * void, and verify(). Each case runs inside one rolled-back transaction.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { phase9PressingApplyHandler as handler, type Phase9PressingEvent } from "../server/edge/phase9PressingApply";
import { withRolledBackPool } from "./helpers/routedPoolClient";

interface World {
  client: PoolClient;
  companyId: number;
  userId: string;
  machineId: number;
  assignmentId: number;
  baleId: number;
  reference: string;
  event: (overrides?: Partial<Phase9PressingEvent["payload"]>, operationId?: string) => Phase9PressingEvent;
}

let seq = 0;

async function withWorld(work: (world: World) => Promise<void>): Promise<void> {
  await withRolledBackPool(async (client) => {
    const tag = `P9P${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase();
    const one = async (text: string, params: unknown[]) => (await client.query(text, params)).rows[0].id;
    const companyId = await one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
      tag,
    ]);
    const userId = String(
      await one(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`${tag.toLowerCase()}_op`])
    );
    await client.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Factory Worker')`, [
      userId,
      companyId,
    ]);
    const machineId = await one(
      `INSERT INTO factory_pressing_machines (company_id, machine_code, name) VALUES ($1, 'PRESS', 'Press A') RETURNING id`,
      [companyId]
    );
    const assignmentId = await one(
      `INSERT INTO factory_pressing_assignments (company_id, machine_id, user_id, assigned_by) VALUES ($1, $2, $3, $3) RETURNING id`,
      [companyId, machineId, userId]
    );
    const reference = `${tag}-B1`;
    const baleId = await one(
      `INSERT INTO factory_bales (company_id, reference_number, article_code, product_name, weight_kg)
       VALUES ($1, $2, 'ART', 'Product', 42) RETURNING id`,
      [companyId, reference]
    );
    let op = 0;
    const event: World["event"] = (overrides = {}, operationId) => ({
      sequence: "1",
      operationId: operationId ?? `${tag.toLowerCase()}-op-${++op}`,
      companyId,
      actorUserId: userId,
      kind: "pressing.confirmation.v1",
      localRef: 1,
      payloadSha256: "0".repeat(64),
      payload: {
        requestId: "r",
        companyId,
        actorUserId: userId,
        localConfirmationId: 1,
        baleId,
        machineId,
        assignmentId,
        referenceNumber: reference,
        confirmedAt: "2026-10-29T08:30:00Z",
        deviceCapturedAt: null,
        productionDate: "2026-10-29",
        timezoneName: "Asia/Beirut",
        ...overrides,
      },
    });
    await work({ client, companyId, userId, machineId, assignmentId, baleId, reference, event });
  });
}

/** The DB only allows a void that follows a VOID correction by the same supervisor. */
async function voidConfirmation(client: PoolClient, companyId: number, confirmationId: number, supervisor: string) {
  const voidId = (
    await client.query(
      `INSERT INTO factory_pressing_corrections (company_id, confirmation_id, action, reason, supervisor_user_id)
       VALUES ($1, $2, 'VOID', 'wrong bale', $3) RETURNING id`,
      [companyId, confirmationId, supervisor]
    )
  ).rows[0].id;
  await client.query(`UPDATE factory_pressing_confirmations SET voided_at = now(), voided_by = $2 WHERE id = $1`, [
    confirmationId,
    supervisor,
  ]);
  return voidId;
}

async function conflictCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String((error as { code?: string }).code ?? (error as Error).message);
  }
  return "resolved";
}

describe("phase9PressingApplyHandler.authorize", () => {
  it("accepts an active operator and refuses revoked, inactive, POS-view-only and read-only actors", async () => {
    await withWorld(async ({ client, event, userId, companyId }) => {
      await expect(handler.authorize(client, event())).resolves.toBeUndefined();

      expect(await conflictCode(handler.authorize(client, { ...event(), actorUserId: "missing-user" }))).toBe(
        "PHASE9_ACTOR_ACCESS_REVOKED"
      );
      await client.query(`UPDATE user_company_roles SET pos_view_only = true WHERE user_id = $1`, [userId]);
      expect(await conflictCode(handler.authorize(client, event()))).toBe("PHASE9_ACTOR_ROLE_NOT_PERMITTED");
      await client.query(`UPDATE user_company_roles SET pos_view_only = false, role = 'View Only' WHERE user_id = $1`, [
        userId,
      ]);
      expect(await conflictCode(handler.authorize(client, event()))).toBe("PHASE9_ACTOR_ROLE_NOT_PERMITTED");
      await client.query(`UPDATE users SET active = false WHERE id = $1`, [userId]);
      expect(await conflictCode(handler.authorize(client, event()))).toBe("PHASE9_ACTOR_ACCESS_REVOKED");
      expect(companyId).toBeGreaterThan(0);
    });
  });
});

describe("phase9PressingApplyHandler.apply", () => {
  it("creates a closed replay session, confirmation and audit, then replays the same request as already-present", async () => {
    await withWorld(async ({ client, event, companyId, userId, baleId, machineId }) => {
      await client.query(
        `INSERT INTO factory_user_profiles (company_id, user_id, display_name) VALUES ($1, $2, '  Op One ')`,
        [companyId, userId]
      );
      const e = event({ deviceCapturedAt: "2026-10-29T08:29:00Z" });
      const result = await handler.apply(client, e);
      expect(result).toMatchObject({ outcome: "cloud-applied", businessDate: "2026-10-29" });

      const [row] = (
        await client.query(
          `SELECT c.user_name_snapshot, c.machine_name_snapshot, c.weight_kg::text AS w, s.ended_at IS NOT NULL AS closed
             FROM factory_pressing_confirmations c JOIN factory_pressing_sessions s ON s.id = c.session_id
            WHERE c.id = $1`,
          [result.cloudRef]
        )
      ).rows;
      expect(row).toEqual({
        user_name_snapshot: "Op One",
        machine_name_snapshot: "Press A",
        w: "42.000",
        closed: true,
      });
      const audit = await client.query(
        `SELECT 1 FROM audit_log WHERE table_name = 'factory_pressing_confirmations' AND record_id = $1`,
        [String(result.cloudRef)]
      );
      expect(audit.rows).toHaveLength(1);
      await expect(handler.verify(client, e, result)).resolves.toBe(true);
      await expect(handler.verify(client, e, { ...result, businessDate: "2026-10-30" })).resolves.toBe(false);

      await expect(handler.apply(client, e)).resolves.toEqual({
        outcome: "already-present",
        cloudRef: result.cloudRef,
        businessDate: "2026-10-29",
      });
      expect(
        await conflictCode(handler.apply(client, { ...e, payload: { ...e.payload, machineId: machineId + 1 } }))
      ).toBe("PHASE9_PRESSING_REQUEST_ID_DIVERGED");

      await voidConfirmation(client, companyId, result.cloudRef, userId);
      expect(await conflictCode(handler.apply(client, e))).toBe("PHASE9_PRESSING_REQUEST_ID_DIVERGED");
      expect(baleId).toBeGreaterThan(0);
    });
  });

  it("refuses missing machine, assignment, deleted bale and diverged bale reference", async () => {
    await withWorld(async ({ client, event, machineId, assignmentId, baleId }) => {
      expect(await conflictCode(handler.apply(client, event({ machineId: machineId + 100000 })))).toBe(
        "PHASE9_PRESSING_MACHINE_MISSING"
      );
      expect(await conflictCode(handler.apply(client, event({ assignmentId: assignmentId + 100000 })))).toBe(
        "PHASE9_PRESSING_ASSIGNMENT_MISSING"
      );
      expect(await conflictCode(handler.apply(client, event({ baleId: baleId + 100000 })))).toBe(
        "PHASE9_PRESSING_BALE_MISSING"
      );
      expect(await conflictCode(handler.apply(client, event({ referenceNumber: "OTHER-REF" })))).toBe(
        "PHASE9_PRESSING_BALE_REFERENCE_DIVERGED"
      );
      await client.query(`UPDATE factory_bales SET status = 'DELETED' WHERE id = $1`, [baleId]);
      expect(await conflictCode(handler.apply(client, event()))).toBe("PHASE9_PRESSING_BALE_MISSING");
      const written = await client.query(`SELECT 1 FROM factory_pressing_confirmations WHERE bale_id = $1`, [baleId]);
      expect(written.rows).toHaveLength(0);
    });
  });

  it("refuses a bale that already has an active confirmation from another request", async () => {
    await withWorld(async ({ client, event }) => {
      await handler.apply(client, event());
      expect(await conflictCode(handler.apply(client, event()))).toBe("PHASE9_PRESSING_ALREADY_CONFIRMED");
    });
  });

  it("reuses the operator's open session and links a RECONFIRM after a supervisor void", async () => {
    await withWorld(async ({ client, event, companyId, userId, machineId, assignmentId, baleId }) => {
      const sessionId = (
        await client.query(
          `INSERT INTO factory_pressing_sessions (company_id, user_id, machine_id, assignment_id, started_at)
           VALUES ($1, $2, $3, $4, now()) RETURNING id`,
          [companyId, userId, machineId, assignmentId]
        )
      ).rows[0].id;
      const first = await handler.apply(client, event());
      const [session] = (
        await client.query(`SELECT session_id FROM factory_pressing_confirmations WHERE id = $1`, [first.cloudRef])
      ).rows;
      expect(session.session_id).toBe(sessionId);

      const voidId = await voidConfirmation(client, companyId, first.cloudRef, userId);
      const second = await handler.apply(client, event());
      expect(second.outcome).toBe("cloud-applied");
      const corrections = await client.query(
        `SELECT replacement_confirmation_id, reason FROM factory_pressing_corrections
          WHERE company_id = $1 AND action = 'RECONFIRM'`,
        [companyId]
      );
      expect(corrections.rows).toEqual([
        {
          replacement_confirmation_id: second.cloudRef,
          reason: `Replacement pressing scan after supervisor void #${voidId}`,
        },
      ]);
      expect(baleId).toBeGreaterThan(0);
    });
  });

  it("snapshots 'Display name not set' when the operator has no or a blank profile name", async () => {
    await withWorld(async ({ client, event, companyId, userId }) => {
      const first = await handler.apply(client, event());
      await client.query(
        `INSERT INTO factory_user_profiles (company_id, user_id, display_name) VALUES ($1, $2, '   ')`,
        [companyId, userId]
      );
      await voidConfirmation(client, companyId, first.cloudRef, userId);
      const second = await handler.apply(client, event());
      const rows = await client.query(
        `SELECT user_name_snapshot FROM factory_pressing_confirmations WHERE id = ANY($1::int[]) ORDER BY id`,
        [[first.cloudRef, second.cloudRef]]
      );
      expect(rows.rows.map((r) => r.user_name_snapshot)).toEqual(["Display name not set", "Display name not set"]);
    });
  });
});
