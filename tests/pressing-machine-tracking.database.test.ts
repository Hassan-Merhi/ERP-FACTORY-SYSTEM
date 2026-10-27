/**
 * Pressing Machines Tracking against a real PostgreSQL schema (CI's database
 * service, or a local DATABASE_URL). Exercises the actual route handlers of
 * all eight phases end to end — machines and assignments, server-side
 * confirmation with lifetime duplicate prevention and idempotent replay,
 * downtime rejection, configured shifts and session rollover, permanent
 * history and totals, supervisor voids with append-only corrections, audited
 * rescans, cross-company isolation — plus genuine concurrency races and the
 * database triggers that protect the evidence.
 *
 * Nothing here finalizes stock: the fixture bale's status, weight and the
 * voucher table are asserted unchanged after every pressing write.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, requireAuth: pass, requireNonPOS: pass, requireRole: () => pass };
});

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { registerFactoryPressingMachineManagementRoutes } from "../server/routes/factory/factoryPressingMachineManagementRoutes";
import { registerFactoryPressingConfirmRoutes } from "../server/routes/factory/factoryPressingConfirmationRoutes";
import { registerFactoryPressingReportRoutes } from "../server/routes/factory/factoryPressingReportRoutes";
import { registerFactoryPressingOperationsRoutes } from "../server/routes/factory/factoryPressingOperationsRoutes";
import { registerFactoryPressingCorrectionRoutes } from "../server/routes/factory/factoryPressingCorrectionRoutes";
import { matchingShift, type PressingShiftDefinition } from "../server/services/factory/pressingShiftTime";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const databaseDescribe = hasDatabase ? describe : describe.skip;

type Handler = (req: any, res: any, next: () => void) => unknown;
const routes = new Map<string, Handler[]>();
const app: any = new Proxy(
  {},
  {
    get:
      (_target, method: string) =>
      (path: string, ...handlers: Handler[]) =>
        routes.set(`${method.toUpperCase()} ${path}`, handlers),
  }
);
registerFactoryPressingMachineManagementRoutes(app);
registerFactoryPressingConfirmRoutes(app);
registerFactoryPressingReportRoutes(app);
registerFactoryPressingOperationsRoutes(app);
registerFactoryPressingCorrectionRoutes(app);

interface Actor {
  userId: string;
  companyId: number;
  username: string;
}
interface CallOptions {
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
}
async function call(route: string, actor: Actor, options: CallOptions = {}) {
  const handlers = routes.get(route);
  if (!handlers) throw new Error(`route not registered: ${route}`);
  const [method, path] = route.split(" ");
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    set: () => res,
    setHeader: () => res,
  };
  const req = {
    method,
    path,
    originalUrl: path,
    params: options.params ?? {},
    query: options.query ?? {},
    body: options.body ?? {},
    session: {
      userId: actor.userId,
      username: actor.username,
      factoryCompanyId: actor.companyId,
      currentCompanyId: actor.companyId,
    },
  };
  for (const handler of handlers) {
    let advanced = false;
    await handler(req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res as { statusCode: number; body: any };
}
const one = async (query: ReturnType<typeof sql>) => {
  const result: any = await db.execute(query);
  return Number(result.rows[0]?.id);
};
const rows = async (query: ReturnType<typeof sql>) => ((await db.execute(query)) as any).rows as any[];

databaseDescribe("Pressing Machines Tracking — PostgreSQL integration", () => {
  const suffix = `${process.pid}${Date.now() % 100000}`;
  const companies: Record<"a" | "b", number> = { a: 0, b: 0 };
  const users: Record<string, Actor> = {};
  const bales: Record<string, { id: number; ref: string }> = {};
  const machines: Record<string, number> = {};
  let voucherCountBefore = 0;

  const bale =
    (key: string, companyId: number, status = "PENDING_PRESSING", deleted = false) =>
    async () => {
      const ref = `PRS-${key.toUpperCase()}-${suffix}`;
      const id =
        await one(sql`INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, weight_kg, status, deleted_at)
      VALUES (${companyId}, ${ref}, ${ref}, ${"ART-" + key}, ${"Bale " + key}, 45.5, ${status}, ${deleted ? sql`now()` : null}) RETURNING id`);
      bales[key] = { id, ref };
    };
  const user = async (
    key: string,
    companyId: number,
    role: string,
    options: { posViewOnly?: boolean; active?: boolean } = {}
  ) => {
    const id = `pressing-${key}-${suffix}`;
    await db.execute(
      sql`INSERT INTO users (id, username, password, active) VALUES (${id}, ${key + suffix}, 'x', ${options.active ?? true})`
    );
    await db.execute(sql`INSERT INTO user_company_roles (user_id, company_id, role, pos_view_only)
      VALUES (${id}, ${companyId}, ${role}, ${options.posViewOnly ?? false})`);
    users[key] = { userId: id, companyId, username: key + suffix };
  };
  const confirm = (actor: Actor, barcode: string, assignmentId: number, machineId: number, requestId = randomUUID()) =>
    call("POST /api/factory/pressing-machines/confirm", actor, {
      body: { barcode, assignmentId, machineId, requestId, deviceCapturedAt: new Date().toISOString() },
    });
  const assign = (actor: Actor, machineId: number, userId: string) =>
    call("POST /api/factory/pressing-machines/assignments", actor, { body: { machineId, userId } });
  const activeAssignment = async (userId: string) => {
    const [row] = await rows(sql`SELECT id, machine_id FROM factory_pressing_assignments
      WHERE user_id = ${userId} AND unassigned_at IS NULL`);
    return row as { id: number; machine_id: number } | undefined;
  };
  const baleUnchanged = async (key: string) => {
    const [row] = await rows(
      sql`SELECT status, weight_kg::text AS weight, pressed_at, finalized_at FROM factory_bales WHERE id = ${bales[key].id}`
    );
    expect(row).toMatchObject({ status: "PENDING_PRESSING", weight: "45.500", pressed_at: null, finalized_at: null });
    const [{ count }] = await rows(sql`SELECT COUNT(*)::int AS count FROM vouchers`);
    expect(count).toBe(voucherCountBefore);
  };

  beforeAll(async () => {
    companies.a = await one(
      sql`INSERT INTO companies (code, name, company_type) VALUES (${"PRA" + suffix}, 'Pressing A', 'factory') RETURNING id`
    );
    companies.b = await one(
      sql`INSERT INTO companies (code, name, company_type) VALUES (${"PRB" + suffix}, 'Pressing B', 'factory') RETURNING id`
    );
    await db.execute(sql`INSERT INTO factory_settings (company_id, extra_settings)
      VALUES (${companies.a}, ${JSON.stringify({ pressingTimezone: "Africa/Lubumbashi" })}::jsonb)`);
    await user("supA", companies.a, "Manager");
    await user("opA1", companies.a, "Worker");
    await user("opA2", companies.a, "Worker");
    await user("viewA", companies.a, "View Only");
    await user("posA", companies.a, "Manager", { posViewOnly: true });
    await user("supB", companies.b, "Manager");
    await user("opB1", companies.b, "Worker");
    for (const make of [
      bale("one", companies.a),
      bale("two", companies.a),
      bale("race", companies.a),
      bale("void", companies.a),
      bale("shift", companies.a),
      bale("down", companies.a),
      bale("conc", companies.a),
      bale("done", companies.a, "IN_STOCK"),
      bale("gone", companies.a, "PENDING_PRESSING", true),
      bale("other", companies.b),
    ])
      await make();
    const [{ count }] = await rows(sql`SELECT COUNT(*)::int AS count FROM vouchers`);
    voucherCountBefore = count;
  }, 60_000);

  afterAll(async () => {
    if (!companies.a) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Append-only pressing evidence is protected by triggers; superuser test
      // teardown switches them off for this one transaction, exactly like the
      // audit_log helper. The application role never has this power.
      await client.query("SET LOCAL session_replication_role = replica");
      const ids = [companies.a, companies.b];
      for (const table of [
        "factory_pressing_corrections",
        "factory_pressing_confirmations",
        "factory_pressing_downtime",
        "factory_pressing_sessions",
        "factory_pressing_assignments",
        "factory_pressing_shifts",
        "factory_pressing_saved_views",
        "factory_pressing_machines",
        "factory_bales",
        "factory_settings",
        "user_company_roles",
      ])
        await client.query(`DELETE FROM ${table} WHERE company_id = ANY($1::int[])`, [ids]);
      await client.query("DELETE FROM users WHERE id LIKE $1", [`pressing-%-${suffix}`]);
      await client.query("DELETE FROM companies WHERE id = ANY($1::int[])", [ids]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await deleteAuditLogRowsForTests(pool, "company_id = ANY($1::int[])", [[companies.a, companies.b]]);
  });

  describe("Phase 2 — machines and one active assignment per operator", () => {
    it("lets supervisors create machines and refuses workers, view-only and other companies", async () => {
      const created = await call("POST /api/factory/pressing-machines", users.supA, {
        body: { machineCode: "press-01", name: "Press 01" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.body.machineCode).toBe("PRESS-01");
      machines.m1 = created.body.id;
      machines.m2 = (
        await call("POST /api/factory/pressing-machines", users.supA, {
          body: { machineCode: "PRESS-02", name: "Press 02" },
        })
      ).body.id;
      machines.b1 = (
        await call("POST /api/factory/pressing-machines", users.supB, {
          body: { machineCode: "PRESS-01", name: "B Press" },
        })
      ).body.id;
      expect(
        (await call("POST /api/factory/pressing-machines", users.opA1, { body: { machineCode: "X", name: "X" } }))
          .statusCode
      ).toBe(403);
      expect(
        (await call("POST /api/factory/pressing-machines", users.posA, { body: { machineCode: "X", name: "X" } }))
          .statusCode
      ).toBe(403);
      expect(
        (
          await call("POST /api/factory/pressing-machines", users.supA, {
            body: { machineCode: "PRESS-01", name: "Dup" },
          })
        ).statusCode
      ).toBe(409);
      const dashboardB = await call("GET /api/factory/pressing-machines", users.supB);
      expect(dashboardB.body.machines.map((m: any) => m.id)).toEqual([machines.b1]);
      expect(dashboardB.body.operators.map((o: any) => o.id)).not.toContain(users.opA1.userId);
      expect((await call("GET /api/factory/pressing-machines", users.viewA)).statusCode).toBe(403);
    });

    it("keeps exactly one active assignment per operator, even when reassignments race", async () => {
      expect((await assign(users.supA, machines.m1, users.opA1.userId)).statusCode).toBe(201);
      expect((await assign(users.supA, machines.m1, users.opA1.userId)).body.unchanged).toBe(true);
      expect((await assign(users.supA, machines.m1, users.viewA.userId)).statusCode).toBe(422);
      expect((await assign(users.supA, machines.b1, users.opA1.userId)).statusCode).toBe(422);
      expect((await assign(users.supB, machines.m1, users.opB1.userId)).statusCode).toBe(422);
      const race = await Promise.all([
        assign(users.supA, machines.m2, users.opA1.userId),
        assign(users.supA, machines.m1, users.opA1.userId),
        assign(users.supA, machines.m2, users.opA1.userId),
      ]);
      expect(race.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
      const active = await rows(
        sql`SELECT id FROM factory_pressing_assignments WHERE user_id = ${users.opA1.userId} AND unassigned_at IS NULL`
      );
      expect(active).toHaveLength(1);
      const history = await call("GET /api/factory/pressing-machines/history", users.supA, {
        query: { userId: users.opA1.userId },
      });
      expect(history.body.length).toBeGreaterThanOrEqual(2);
      expect(history.body.filter((h: any) => h.unassignedAt !== null).length).toBe(history.body.length - 1);
      // Settle on PRESS-02 for the worker and PRESS-01 for the second worker.
      await assign(users.supA, machines.m2, users.opA1.userId);
      await assign(users.supA, machines.m1, users.opA2.userId);
      const me = await call("GET /api/factory/pressing-machines/me", users.opA1);
      expect(me.body).toMatchObject({ companyId: companies.a, userId: users.opA1.userId, canManage: false });
      expect(me.body.assignment.machineId).toBe(machines.m2);
    });
  });

  describe("Phase 4 — server confirmation, idempotency and lifetime duplicate prevention", () => {
    it("records one confirmation with machine, operator, KG, shift, server time and request ID", async () => {
      const a = (await activeAssignment(users.opA1.userId))!;
      const requestId = randomUUID();
      const first = await confirm(users.opA1, bales.one.ref.toLowerCase(), a.id, a.machine_id, requestId);
      expect(first.statusCode).toBe(201);
      expect(first.body).toMatchObject({
        status: "PRESSING_COMPLETED",
        referenceNumber: bales.one.ref,
        weightKg: "45.500",
        machineId: machines.m2,
        operatorUserId: users.opA1.userId,
        assignmentId: a.id,
        requestId,
        replayed: false,
        inventoryFinalized: false,
        timezoneName: "Africa/Lubumbashi",
      });
      expect(first.body.productionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const replay = await confirm(users.opA1, bales.one.ref, a.id, a.machine_id, requestId);
      expect(replay.statusCode).toBe(200);
      expect(replay.body).toMatchObject({ id: first.body.id, replayed: true });
      const reused = await confirm(users.opA1, bales.two.ref, a.id, a.machine_id, requestId);
      expect(reused.body.code).toBe("PRESSING_REQUEST_ID_REUSED");
      const stored = await rows(
        sql`SELECT * FROM factory_pressing_confirmations WHERE company_id = ${companies.a} AND bale_id = ${bales.one.id}`
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        session_id: expect.any(Number),
        machine_name_snapshot: "Press 02",
        voided_at: null,
      });
      const audit = await rows(
        sql`SELECT action FROM audit_log WHERE company_id = ${companies.a} AND table_name = 'factory_pressing_confirmations' AND record_id = ${first.body.id}`
      );
      expect(audit.map((r) => r.action)).toContain("create");
      await baleUnchanged("one");
    });

    it("rejects the same bale from another machine, operator, device or day", async () => {
      const a2 = (await activeAssignment(users.opA2.userId))!;
      const duplicate = await confirm(users.opA2, bales.one.ref, a2.id, a2.machine_id);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.body.code).toBe("PRESSING_ALREADY_CONFIRMED");
      expect(duplicate.body.previous).toMatchObject({ machineName: "Press 02", operatorUserId: users.opA1.userId });
    });

    it("rejects finalized, deleted, unknown, other-company bales and unauthorized actors", async () => {
      const a = (await activeAssignment(users.opA1.userId))!;
      expect((await confirm(users.opA1, bales.done.ref, a.id, a.machine_id)).body.code).toBe(
        "PRESSING_BALE_NOT_PENDING"
      );
      expect((await confirm(users.opA1, bales.gone.ref, a.id, a.machine_id)).statusCode).toBe(404);
      expect((await confirm(users.opA1, bales.other.ref, a.id, a.machine_id)).statusCode).toBe(404);
      expect((await confirm(users.opA1, "NOPE-" + suffix, a.id, a.machine_id)).statusCode).toBe(404);
      expect((await confirm(users.viewA, bales.two.ref, a.id, a.machine_id)).body.code).toBe("PRESSING_WRITE_DENIED");
      // Another worker cannot borrow this worker's assignment.
      expect((await confirm(users.opA2, bales.two.ref, a.id, a.machine_id)).body.code).toBe(
        "PRESSING_ASSIGNMENT_CHANGED"
      );
      // A company-B supervisor cannot use company-A identifiers.
      expect((await confirm(users.supB, bales.two.ref, a.id, a.machine_id)).statusCode).toBeGreaterThanOrEqual(400);
      expect(
        (
          await call("POST /api/factory/pressing-machines/confirm", users.opA1, {
            body: { barcode: "x", assignmentId: a.id, machineId: a.machine_id, requestId: "not-a-uuid" },
          })
        ).statusCode
      ).toBe(400);
      expect(
        await rows(
          sql`SELECT 1 FROM factory_pressing_confirmations WHERE bale_id IN (${bales.done.id}, ${bales.gone.id}, ${bales.other.id})`
        )
      ).toHaveLength(0);
    });

    it("lets exactly one of two racing operators on different machines confirm the same bale", async () => {
      const a1 = (await activeAssignment(users.opA1.userId))!;
      const a2 = (await activeAssignment(users.opA2.userId))!;
      const results = await Promise.all([
        confirm(users.opA1, bales.race.ref, a1.id, a1.machine_id),
        confirm(users.opA2, bales.race.ref, a2.id, a2.machine_id),
        confirm(users.opA1, bales.race.ref, a1.id, a1.machine_id),
        confirm(users.opA2, bales.race.ref, a2.id, a2.machine_id),
      ]);
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter((r) => r.body?.code === "PRESSING_ALREADY_CONFIRMED")).toHaveLength(3);
      expect(
        await rows(
          sql`SELECT 1 FROM factory_pressing_confirmations WHERE bale_id = ${bales.race.id} AND voided_at IS NULL`
        )
      ).toHaveLength(1);
      await baleUnchanged("race");
    });

    it("collapses concurrent retries of one request ID (lost response) into one row", async () => {
      const a1 = (await activeAssignment(users.opA1.userId))!;
      const requestId = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => confirm(users.opA1, bales.conc.ref, a1.id, a1.machine_id, requestId))
      );
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 200 && r.body.replayed)).toHaveLength(5);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(
        await rows(sql`SELECT 1 FROM factory_pressing_confirmations WHERE request_id = ${requestId}`)
      ).toHaveLength(1);
    });
  });

  describe("Phase 7 — shifts, session rollover and recorded downtime", () => {
    let dayShift: any;
    it("validates supervisor shifts: overlap, timezone mismatch, overnight", async () => {
      const day = await call("POST /api/factory/pressing-machines/shifts", users.supA, {
        body: {
          shiftCode: "day",
          name: "Day",
          startLocal: "07:00",
          endLocal: "15:00",
          timezoneName: "Africa/Lubumbashi",
          active: true,
        },
      });
      expect(day.statusCode).toBe(201);
      dayShift = day.body;
      const night = await call("POST /api/factory/pressing-machines/shifts", users.supA, {
        body: {
          shiftCode: "NIGHT",
          name: "Night",
          startLocal: "22:00",
          endLocal: "06:00",
          timezoneName: "Africa/Lubumbashi",
          active: true,
        },
      });
      expect(night.statusCode).toBe(201);
      expect(
        (
          await call("POST /api/factory/pressing-machines/shifts", users.supA, {
            body: {
              shiftCode: "OVL",
              name: "Overlap",
              startLocal: "14:00",
              endLocal: "23:00",
              timezoneName: "Africa/Lubumbashi",
              active: true,
            },
          })
        ).body.code
      ).toBe("PRESSING_SHIFT_OVERLAP");
      expect(
        (
          await call("POST /api/factory/pressing-machines/shifts", users.supA, {
            body: {
              shiftCode: "TZ",
              name: "Other zone",
              startLocal: "15:00",
              endLocal: "22:00",
              timezoneName: "Europe/Paris",
              active: true,
            },
          })
        ).body.code
      ).toBe("PRESSING_SHIFT_TIMEZONE_CONFLICT");
      expect(
        (
          await call("POST /api/factory/pressing-machines/shifts", users.supA, {
            body: {
              shiftCode: "BAD",
              name: "Bad",
              startLocal: "15:00",
              endLocal: "22:00",
              timezoneName: "Mars/Olympus",
              active: true,
            },
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await call("POST /api/factory/pressing-machines/shifts", users.opA1, {
            body: {
              shiftCode: "W",
              name: "W",
              startLocal: "15:00",
              endLocal: "22:00",
              timezoneName: "Africa/Lubumbashi",
              active: true,
            },
          })
        ).statusCode
      ).toBe(403);
      expect((await call("GET /api/factory/pressing-machines/shifts", users.supB)).body).toEqual([]);
      const current = await call("GET /api/factory/pressing-machines/shifts/current", users.opA1);
      const configured = (await call("GET /api/factory/pressing-machines/shifts", users.supA))
        .body as PressingShiftDefinition[];
      const expected = matchingShift(configured, new Date(current.body.serverTime));
      expect(current.body.shift?.id ?? null).toBe(expected?.id ?? null);
    });

    it("stamps the server-resolved shift and rolls the session over at a shift change", async () => {
      const a1 = (await activeAssignment(users.opA1.userId))!;
      const [before] = await rows(
        sql`SELECT id, shift_id FROM factory_pressing_sessions WHERE user_id = ${users.opA1.userId} AND ended_at IS NULL`
      );
      // Simulate the operator's open session belonging to a different shift
      // than the one the server resolves right now (a shift boundary passed).
      const nowShift = (await call("GET /api/factory/pressing-machines/shifts/current", users.opA1)).body.shift;
      const otherShift = nowShift?.id === dayShift.id ? null : dayShift.id;
      await db.execute(sql`UPDATE factory_pressing_sessions SET shift_id = ${otherShift} WHERE id = ${before.id}`);
      const result = await confirm(users.opA1, bales.shift.ref, a1.id, a1.machine_id);
      expect(result.statusCode).toBe(201);
      const configured = (await call("GET /api/factory/pressing-machines/shifts", users.supA))
        .body as PressingShiftDefinition[];
      const resolved = matchingShift(configured, new Date(result.body.confirmedAt));
      expect(result.body.shiftId).toBe(resolved?.id ?? null);
      expect(result.body.sessionId).not.toBe(before.id);
      const [ended] = await rows(sql`SELECT ended_at FROM factory_pressing_sessions WHERE id = ${before.id}`);
      expect(ended.ended_at).not.toBeNull();
      const open = await rows(
        sql`SELECT id FROM factory_pressing_sessions WHERE user_id = ${users.opA1.userId} AND ended_at IS NULL`
      );
      expect(open).toHaveLength(1);
    });

    it("rejects scans while a machine is marked down and accepts them after downtime ends", async () => {
      const a1 = (await activeAssignment(users.opA1.userId))!;
      const start = await call("POST /api/factory/pressing-machines/downtime/start", users.supA, {
        body: { machineId: a1.machine_id, reasonCode: "MACHINE_FAULT", reasonNotes: "belt" },
      });
      expect(start.statusCode).toBe(201);
      expect(
        (
          await call("POST /api/factory/pressing-machines/downtime/start", users.supA, {
            body: { machineId: a1.machine_id, reasonCode: "BREAK" },
          })
        ).statusCode
      ).toBe(409);
      expect(
        (
          await call("POST /api/factory/pressing-machines/downtime/start", users.opA1, {
            body: { machineId: a1.machine_id, reasonCode: "BREAK" },
          })
        ).statusCode
      ).toBe(403);
      const blocked = await confirm(users.opA1, bales.down.ref, a1.id, a1.machine_id);
      expect(blocked.body.code).toBe("PRESSING_MACHINE_DOWN");
      expect(
        await rows(sql`SELECT 1 FROM factory_pressing_confirmations WHERE bale_id = ${bales.down.id}`)
      ).toHaveLength(0);
      expect(
        (
          await call("POST /api/factory/pressing-machines/downtime/:id/end", users.supB, {
            params: { id: String(start.body.id) },
          })
        ).statusCode
      ).toBe(404);
      const ended = await call("POST /api/factory/pressing-machines/downtime/:id/end", users.supA, {
        params: { id: String(start.body.id) },
      });
      expect(ended.body.endedAt).not.toBeNull();
      const again = await call("POST /api/factory/pressing-machines/downtime/:id/end", users.supA, {
        params: { id: String(start.body.id) },
      });
      expect(again.body.endedAt).toEqual(ended.body.endedAt);
      expect((await confirm(users.opA1, bales.down.ref, a1.id, a1.machine_id)).statusCode).toBe(201);
      const list = await call("GET /api/factory/pressing-machines/downtime", users.supA);
      expect(list.body.map((d: any) => d.id)).toContain(start.body.id);
    });
  });

  describe("Phase 6 — permanent history, scope and totals", () => {
    it("shows supervisors every company record, operators only their own, and nothing across companies", async () => {
      const all = await call("GET /api/factory/pressing-machines/report", users.supA, {
        query: { status: "all", limit: "250" },
      });
      expect(all.statusCode).toBe(200);
      const supervisorIds = all.body.rows.map((r: any) => r.id);
      const [{ active, voided }] = await rows(sql`SELECT COUNT(*) FILTER (WHERE voided_at IS NULL)::int AS active,
        COUNT(*) FILTER (WHERE voided_at IS NOT NULL)::int AS voided FROM factory_pressing_confirmations WHERE company_id = ${companies.a}`);
      expect(active).toBeGreaterThanOrEqual(4);
      expect(all.body.summary).toMatchObject({ totalBales: active, voidedBales: voided });
      expect(all.body.total).toBe(active + voided);
      const own = await call("GET /api/factory/pressing-machines/report", users.opA2, { query: { status: "all" } });
      expect(own.body.rows.every((r: any) => r.operatorUserId === users.opA2.userId)).toBe(true);
      expect(own.body.rows.length).toBeLessThan(supervisorIds.length);
      expect(
        (await call("GET /api/factory/pressing-machines/report", users.opA2, { query: { userId: users.opA1.userId } }))
          .statusCode
      ).toBe(403);
      const foreign = await call("GET /api/factory/pressing-machines/report", users.supB, { query: { status: "all" } });
      expect(foreign.body.total).toBe(0);
      expect(
        (await call("GET /api/factory/pressing-machines/report", users.supA, { query: { from: "2026-02-30" } }))
          .statusCode
      ).toBe(400);
      expect(
        (
          await call("GET /api/factory/pressing-machines/report", users.supA, {
            query: { from: "2026-03-02", to: "2026-03-01" },
          })
        ).statusCode
      ).toBe(400);
      const condensed = await call("GET /api/factory/pressing-machines/report", users.supA, {
        query: { mode: "condensed", status: "all" },
      });
      const condensedBales = condensed.body.rows.reduce((n: number, r: any) => n + r.bales, 0);
      expect(condensedBales).toBe(all.body.total);
      const options = await call("GET /api/factory/pressing-machines/report/options", users.supA);
      expect(options.body.timeZone).toBe("Africa/Lubumbashi");
      expect(options.body.machines.map((m: any) => m.id).sort()).toEqual([machines.m1, machines.m2].sort());
      expect((await call("GET /api/factory/pressing-machines/report/options", users.opA1)).body.canViewAll).toBe(false);
    });

    it("stores saved views per user and company only", async () => {
      const saved = await call("POST /api/factory/pressing-machines/report/views", users.opA1, {
        body: {
          name: "Mine",
          mode: "detailed",
          filters: { status: "active" },
          visibleColumns: ["referenceNumber", "weightKg"],
          isDefault: true,
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(
        (
          await call("POST /api/factory/pressing-machines/report/views", users.opA1, {
            body: {
              name: "Other",
              mode: "detailed",
              filters: { status: "active", userId: users.opA2.userId },
              visibleColumns: ["referenceNumber"],
              isDefault: false,
            },
          })
        ).statusCode
      ).toBe(403);
      expect((await call("GET /api/factory/pressing-machines/report/views", users.opA2)).body).toEqual([]);
      expect(
        (
          await call("POST /api/factory/pressing-machines/report/views/:id/remove", users.opA2, {
            params: { id: String(saved.body.id) },
          })
        ).statusCode
      ).toBe(404);
      expect(
        (
          await call("POST /api/factory/pressing-machines/report/views/:id/remove", users.opA1, {
            params: { id: String(saved.body.id) },
          })
        ).statusCode
      ).toBe(200);
    });
  });

  describe("Phase 8 — supervisor voids, immutable corrections and audited rescans", () => {
    let original: any;
    it("voids only with a supervisor and a mandatory reason, in one atomic audited transaction", async () => {
      const a1 = (await activeAssignment(users.opA1.userId))!;
      original = (await confirm(users.opA1, bales.void.ref, a1.id, a1.machine_id)).body;
      expect(original.id).toBeGreaterThan(0);
      const voidRoute = "POST /api/factory/pressing-machines/confirmations/:id/void";
      const params = { id: String(original.id) };
      expect(
        (await call(voidRoute, users.opA1, { params, body: { reason: "Operator scanned the wrong bale" } })).statusCode
      ).toBe(403);
      expect(
        (await call(voidRoute, users.posA, { params, body: { reason: "Operator scanned the wrong bale" } })).statusCode
      ).toBe(403);
      expect(
        (await call(voidRoute, users.supB, { params, body: { reason: "Operator scanned the wrong bale" } })).statusCode
      ).toBe(404);
      expect((await call(voidRoute, users.supA, { params, body: { reason: "short" } })).statusCode).toBe(400);
      expect(
        await rows(sql`SELECT 1 FROM factory_pressing_corrections WHERE confirmation_id = ${original.id}`)
      ).toHaveLength(0);
      const voided = await call(voidRoute, users.supA, { params, body: { reason: "Operator scanned the wrong bale" } });
      expect(voided.statusCode).toBe(200);
      expect(voided.body).toMatchObject({ confirmationId: original.id, needsRescan: true, stockFinalized: false });
      const [row] = await rows(sql`SELECT * FROM factory_pressing_confirmations WHERE id = ${original.id}`);
      expect(row.voided_by).toBe(users.supA.userId);
      expect(row.voided_at).not.toBeNull();
      expect(row).toMatchObject({
        reference_number: bales.void.ref,
        machine_id: a1.machine_id,
        user_id: users.opA1.userId,
        weight_kg: "45.500",
        request_id: original.requestId,
      });
      const corrections = await rows(
        sql`SELECT action, reason, supervisor_user_id FROM factory_pressing_corrections WHERE confirmation_id = ${original.id}`
      );
      expect(corrections).toEqual([
        { action: "VOID", reason: "Operator scanned the wrong bale", supervisor_user_id: users.supA.userId },
      ]);
      const audit = await rows(
        sql`SELECT action FROM audit_log WHERE company_id = ${companies.a} AND table_name = 'factory_pressing_confirmations' AND record_id = ${original.id} AND action = 'void'`
      );
      expect(audit).toHaveLength(1);
      expect(
        (await call(voidRoute, users.supA, { params, body: { reason: "Trying to void it a second time" } })).statusCode
      ).toBe(409);
      await baleUnchanged("void");
    });

    it("keeps evidence immutable at the database level", async () => {
      await expect(
        pool.query("UPDATE factory_pressing_confirmations SET reference_number = 'TAMPER' WHERE id = $1", [original.id])
      ).rejects.toThrow(/single audited void/);
      await expect(
        pool.query("DELETE FROM factory_pressing_confirmations WHERE id = $1", [original.id])
      ).rejects.toThrow(/cannot be deleted/);
      await expect(
        pool.query("UPDATE factory_pressing_corrections SET reason = 'edited' WHERE confirmation_id = $1", [
          original.id,
        ])
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query("DELETE FROM factory_pressing_corrections WHERE confirmation_id = $1", [original.id])
      ).rejects.toThrow(/append-only/);
      // Voiding an active confirmation without a prior correction event is refused.
      const [active] = await rows(
        sql`SELECT id FROM factory_pressing_confirmations WHERE bale_id = ${bales.one.id} AND voided_at IS NULL`
      );
      await expect(
        pool.query("UPDATE factory_pressing_confirmations SET voided_at = now(), voided_by = $2 WHERE id = $1", [
          active.id,
          users.supA.userId,
        ])
      ).rejects.toThrow(/correction event must be recorded/);
      // Cross-company foreign keys refuse a company-B machine on a company-A row.
      await expect(
        pool.query(
          "INSERT INTO factory_pressing_assignments (company_id, machine_id, user_id, assigned_by) VALUES ($1, $2, $3, 'x')",
          [companies.a, machines.b1, users.viewA.userId]
        )
      ).rejects.toThrow(/foreign key/);
      // Two active assignments for one operator are refused by the partial unique index.
      await expect(
        pool.query(
          "INSERT INTO factory_pressing_assignments (company_id, machine_id, user_id, assigned_by) VALUES ($1, $2, $3, 'x')",
          [companies.a, machines.m1, users.opA1.userId]
        )
      ).rejects.toThrow(/factory_pressing_assignments_active_user_uk/);
    });

    it("refuses the voided request ID, accepts a new valid rescan once and links it as RECONFIRM", async () => {
      const a1 = (await activeAssignment(users.opA1.userId))!;
      const stale = await confirm(users.opA1, bales.void.ref, a1.id, a1.machine_id, original.requestId);
      expect(stale.body.code).toBe("PRESSING_CONFIRMATION_VOIDED");
      const a2 = (await activeAssignment(users.opA2.userId))!;
      const rescans = await Promise.all([
        confirm(users.opA1, bales.void.ref, a1.id, a1.machine_id),
        confirm(users.opA2, bales.void.ref, a2.id, a2.machine_id),
      ]);
      expect(rescans.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(rescans.filter((r) => r.body.code === "PRESSING_ALREADY_CONFIRMED")).toHaveLength(1);
      const replacement = rescans.find((r) => r.statusCode === 201)!.body;
      const link =
        await rows(sql`SELECT action, replacement_confirmation_id, supervisor_user_id FROM factory_pressing_corrections
        WHERE confirmation_id = ${original.id} AND action = 'RECONFIRM'`);
      expect(link).toEqual([
        { action: "RECONFIRM", replacement_confirmation_id: replacement.id, supervisor_user_id: users.supA.userId },
      ]);
      const active = await rows(
        sql`SELECT id FROM factory_pressing_confirmations WHERE bale_id = ${bales.void.id} AND voided_at IS NULL`
      );
      expect(active).toEqual([{ id: replacement.id }]);
      const report = await call("GET /api/factory/pressing-machines/report", users.supA, {
        query: { search: bales.void.ref, status: "all" },
      });
      expect(report.body.total).toBe(2);
      expect(report.body.summary).toMatchObject({ totalBales: 1, voidedBales: 1, totalKg: "45.500" });
      const history = await call("GET /api/factory/pressing-machines/corrections", users.supA, {
        query: { reference: bales.void.ref },
      });
      expect(history.body.map((c: any) => c.action).sort()).toEqual(["RECONFIRM", "VOID"]);
      expect((await call("GET /api/factory/pressing-machines/corrections", users.opA1)).statusCode).toBe(403);
      expect(
        (
          await call("GET /api/factory/pressing-machines/corrections", users.supB, {
            query: { reference: bales.void.ref },
          })
        ).body
      ).toEqual([]);
      await baleUnchanged("void");
    });

    it("never leaves two active confirmations when a void races a rescan", async () => {
      const a1 = (await activeAssignment(users.opA1.userId))!;
      const a2 = (await activeAssignment(users.opA2.userId))!;
      const [current] = await rows(
        sql`SELECT id FROM factory_pressing_confirmations WHERE bale_id = ${bales.void.id} AND voided_at IS NULL`
      );
      const outcomes = await Promise.all([
        call("POST /api/factory/pressing-machines/confirmations/:id/void", users.supA, {
          params: { id: String(current.id) },
          body: { reason: "Racing void against a rescan" },
        }),
        confirm(users.opA2, bales.void.ref, a2.id, a2.machine_id),
        confirm(users.opA1, bales.void.ref, a1.id, a1.machine_id),
      ]);
      expect(outcomes[0].statusCode).toBe(200);
      const active = await rows(
        sql`SELECT id FROM factory_pressing_confirmations WHERE bale_id = ${bales.void.id} AND voided_at IS NULL`
      );
      expect(active.length).toBeLessThanOrEqual(1);
      const accepted = outcomes.slice(1).filter((r) => r.statusCode === 201);
      expect(accepted.length).toBe(active.length);
      const analytics = await call("GET /api/factory/pressing-machines/analytics", users.supA, {
        query: { from: "2020-01-01", to: new Date().toISOString().slice(0, 10) },
      });
      expect(analytics.statusCode).toBe(400); // more than 91 days
      const today = new Date().toISOString().slice(0, 10);
      const scoped = await call("GET /api/factory/pressing-machines/analytics", users.supA, {
        query: { from: today, to: today },
      });
      expect(scoped.statusCode).toBe(200);
      const activeCount = (
        await rows(
          sql`SELECT COUNT(*)::int AS count FROM factory_pressing_confirmations WHERE company_id = ${companies.a} AND voided_at IS NULL AND production_date = ${today}::date`
        )
      )[0].count;
      expect(scoped.body.summary.bales).toBe(activeCount);
      expect(scoped.body.rateMethod).toBe("OBSERVED_FIRST_TO_LAST_SCAN");
      expect(
        (await call("GET /api/factory/pressing-machines/analytics", users.opA1, { query: { from: today, to: today } }))
          .statusCode
      ).toBe(403);
    });
  });

  describe("Phase 2/8 — deactivation and stale assignments", () => {
    it("deactivating a machine ends its assignments and sessions, and blocks further scans", async () => {
      const a1 = (await activeAssignment(users.opA1.userId))!;
      const off = await call("POST /api/factory/pressing-machines/:id/update", users.supA, {
        params: { id: String(a1.machine_id) },
        body: { active: false },
      });
      expect(off.body.active).toBe(false);
      expect(await activeAssignment(users.opA1.userId)).toBeUndefined();
      expect(
        await rows(sql`SELECT 1 FROM factory_pressing_sessions WHERE assignment_id = ${a1.id} AND ended_at IS NULL`)
      ).toHaveLength(0);
      const stale = await confirm(users.opA1, bales.two.ref, a1.id, a1.machine_id);
      expect(["PRESSING_MACHINE_INACTIVE", "PRESSING_ASSIGNMENT_CHANGED"]).toContain(stale.body.code);
      expect(
        (
          await call("POST /api/factory/pressing-machines/:id/update", users.supB, {
            params: { id: String(a1.machine_id) },
            body: { active: true },
          })
        ).statusCode
      ).toBe(404);
      expect(
        (
          await call("POST /api/factory/pressing-machines/:id/update", users.supA, {
            params: { id: String(a1.machine_id) },
            body: { active: true },
          })
        ).body.active
      ).toBe(true);
      expect(await activeAssignment(users.opA1.userId)).toBeUndefined();
      await baleUnchanged("two");
    });
  });
});
