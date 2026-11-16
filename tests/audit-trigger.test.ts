/**
 * Phase 21 (A) — audit trigger, actors, retention and hash chain.
 *
 *   - AT2: every insert / update / delete of vouchers and voucher_entries is
 *     audited by the database with the row before and after, the actor from
 *     the request setting ('unknown' when none, counted by the diagnostic), and
 *     `system:<job>` in a scheduled scope.
 *   - AT3: created_by / updated_by / deleted_by and the original number kept on
 *     retirement.
 *   - AT4: retirement and application audit rows take the request actor.
 *   - AT5: retention allow-list; triggers present and enabled; hash chain
 *     verification finds an edited row and a deleted linked row.
 *   - AT6: request id, IP, hashed session and reason on audit rows.
 */
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { ensureAuditLogAppendOnlyGuard } from "../server/services/audit/auditLogAppendOnlyGuard";
import { ensureVoucherAuditTrigger } from "../server/services/audit/voucherAuditTrigger";
import { verifyAuditLogChain } from "../server/services/audit/auditLogChain";
import {
  hashSessionId,
  runAsSystemAuditActor,
  runWithAuditActor,
  runWithAuditReason,
} from "../server/services/audit/auditActorContext";
import { isFinancialAuditTable, isPrunableAuditTable } from "../server/services/audit/auditLogRetentionPolicy";
import { writeAuditEvent } from "../server/services/audit";
import { runInCompanyPostingScope } from "../server/services/accounting/scheduledPostingScope";
import { retireVouchersTx } from "../server/services/accounting/voucherRetirement";
import { auditTrailChecks } from "../server/services/accounting/integrity/auditTrailChecks";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { createSchedulerTick } from "../server/services/scheduler/schedulerTickGuard";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p21aaudit";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;

type AuditRow = {
  id: number;
  user_id: string;
  username: string;
  company_id: number | null;
  action: string;
  table_name: string;
  record_id: number | null;
  record_identifier: string | null;
  changes: { source?: string; row?: { old?: Record<string, unknown>; new?: Record<string, unknown> } } | null;
  request_id: string | null;
  ip: string | null;
  session_id: string | null;
  reason: string | null;
  prev_hash: string | null;
  row_hash: string | null;
};

async function rowAudits(table: string, recordId: number): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    `SELECT * FROM audit_log WHERE table_name = $1 AND record_id = $2 AND action LIKE 'row_%' ORDER BY id`,
    [table, recordId]
  );
  return result.rows;
}

/** A balanced journal with `pairs` Dr/Cr pairs of 1.00, written through the application pool. */
async function insertJournal(number: string, pairs = 1): Promise<{ id: number; lineIds: number[] }> {
  return inCompany(() =>
    db.transaction(async (tx) => {
      const voucher = await tx.execute<{ id: number }>(sql`
        INSERT INTO vouchers (company_id, location_id, voucher_number, voucher_type, voucher_date, description,
                              total_amount, currency)
        VALUES (${ctx.companyId}, ${ctx.locationId}, ${number}, 'Journal', CURRENT_DATE, 'phase 21 a', ${pairs}, 'USD')
        RETURNING id`);
      const id = Number(voucher.rows[0].id);
      const lineIds: number[] = [];
      for (let index = 0; index < pairs; index += 1) {
        const lines = await tx.execute<{ id: number }>(sql`
          INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
          VALUES (${id}, ${ctx.cashAccountId}, '1.00', '0', ${`line ${index}`}),
                 (${id}, ${ctx.salesAccountId}, '0', '1.00', ${`line ${index}`})
          RETURNING id`);
        lineIds.push(...lines.rows.map((row) => Number(row.id)));
      }
      return { id, lineIds };
    })
  );
}

/** Runs `run` in the fixture company's tenant scope. */
function inCompany<T>(run: () => Promise<T>): Promise<T> {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(ctx.companyId), run);
}

const ACTOR = {
  actorId: "p21a-user",
  actorName: "p21a tester",
  requestId: "p21a-request-1",
  ip: "10.21.0.1",
  sessionHash: hashSessionId("p21a-session"),
};

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureAuditLogAppendOnlyGuard(pool);
  await ensureVoucherAuditTrigger(pool);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120_000);

afterAll(async () => {
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

describe("AT2/AT3/AT6: the database audits every voucher and line write", () => {
  it("audits inserts with the actor, the request metadata and the row images; sets created_by", async () => {
    const { id, lineIds } = await runWithAuditActor({ ...ACTOR, reason: "p21a create" }, () =>
      insertJournal(`${PREFIX}-INS`)
    );
    const [header] = await rowAudits("vouchers", id);
    expect(header).toMatchObject({
      user_id: "p21a-user",
      username: "p21a tester",
      company_id: ctx.companyId,
      action: "row_insert",
      record_identifier: `${PREFIX}-INS`,
      request_id: "p21a-request-1",
      ip: "10.21.0.1",
      session_id: ACTOR.sessionHash,
      reason: "p21a create",
    });
    expect(header.changes?.source).toBe("db_trigger");
    expect(header.changes?.row?.new).toMatchObject({ id, voucher_number: `${PREFIX}-INS`, created_by: "p21a-user" });
    expect(header.changes?.row?.old ?? null).toBeNull();
    expect(header.row_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(header.prev_hash).toBeTruthy();

    for (const lineId of lineIds) {
      const [line] = await rowAudits("voucher_entries", lineId);
      expect(line).toMatchObject({ user_id: "p21a-user", action: "row_insert", record_identifier: `voucher:${id}` });
      expect(line.changes?.row?.new).toMatchObject({ id: lineId, voucher_id: id });
    }
    const voucher = await pool.query(`SELECT created_by, updated_by, deleted_by FROM vouchers WHERE id = $1`, [id]);
    expect(voucher.rows[0]).toEqual({ created_by: "p21a-user", updated_by: null, deleted_by: null });
  });

  it("audits updates (old and new), skips no-op updates, sets updated_by and keeps created_by", async () => {
    const { id, lineIds } = await runWithAuditActor(ACTOR, () => insertJournal(`${PREFIX}-UPD`));
    await runWithAuditActor({ actorId: "p21a-editor", actorName: "editor" }, () =>
      inCompany(() =>
        db.transaction(async (tx) => {
          await tx.execute(sql`UPDATE vouchers SET description = 'edited', created_by = 'forged' WHERE id = ${id}`);
          await tx.execute(sql`
            UPDATE voucher_entries SET debit_amount = CASE WHEN debit_amount = 0 THEN 0 ELSE 2 END,
                   credit_amount = CASE WHEN credit_amount = 0 THEN 0 ELSE 2 END
             WHERE voucher_id = ${id}`);
          await tx.execute(sql`UPDATE vouchers SET total_amount = 2 WHERE id = ${id}`);
          // No-op update: no audit row.
          await tx.execute(sql`UPDATE vouchers SET description = description WHERE id = ${id}`);
        })
      )
    );
    const header = await rowAudits("vouchers", id);
    expect(header.map((row) => row.action)).toEqual(["row_insert", "row_update", "row_update"]);
    expect(header[1]).toMatchObject({ user_id: "p21a-editor", username: "editor" });
    expect(header[1].changes?.row?.old).toMatchObject({ description: "phase 21 a", created_by: "p21a-user" });
    expect(header[1].changes?.row?.new).toMatchObject({
      description: "edited",
      created_by: "p21a-user",
      updated_by: "p21a-editor",
    });
    const line = await rowAudits("voucher_entries", lineIds[0]);
    expect(line.map((row) => row.action)).toEqual(["row_insert", "row_update"]);
    expect(String(line[1].changes?.row?.old?.debit_amount)).toMatch(/^1(\.0+)?$/);
    expect(String(line[1].changes?.row?.new?.debit_amount)).toMatch(/^2(\.0+)?$/);
  });

  it("audits deletes with the row as it was, and records 'unknown' without an actor (counted by the diagnostic)", async () => {
    const { id, lineIds } = await insertJournal(`${PREFIX}-DEL`, 2);
    const [created] = await rowAudits("vouchers", id);
    expect(created.user_id).toBe("unknown");
    const voucher = await pool.query(`SELECT created_by FROM vouchers WHERE id = $1`, [id]);
    expect(voucher.rows[0].created_by).toBe("unknown");

    await runWithAuditActor(ACTOR, () =>
      inCompany(() =>
        db.transaction(async (tx) => {
          await tx.execute(sql`DELETE FROM voucher_entries WHERE id IN (${lineIds[2]}, ${lineIds[3]})`);
          await tx.execute(sql`UPDATE vouchers SET total_amount = 1 WHERE id = ${id}`);
        })
      )
    );
    const [removed] = (await rowAudits("voucher_entries", lineIds[2])).filter((row) => row.action === "row_delete");
    expect(removed).toMatchObject({ user_id: "p21a-user", record_identifier: `voucher:${id}` });
    expect(removed.changes?.row?.old).toMatchObject({ id: lineIds[2], voucher_id: id });
    expect(removed.changes?.row?.new ?? null).toBeNull();

    const checks = await auditTrailChecks(ctx.companyId);
    const unknown = checks.find((check) => check.key === "audit_actor_unknown");
    expect(unknown?.status).toBe("warn");
    expect(unknown?.count).toBeGreaterThanOrEqual(5); // the header and four lines written without an actor
    expect(checks.find((check) => check.key === "audit_trail_triggers")).toMatchObject({ status: "pass", count: 0 });
  });

  it("audits a scheduled posting as system:<job>", async () => {
    const posted = await runInCompanyPostingScope(ctx.companyId, () => insertJournal(`${PREFIX}-JOB`), "p21a-job");
    expect((await rowAudits("vouchers", posted.id))[0].user_id).toBe("system:p21a-job");

    let tickVoucher = 0;
    const tick = createSchedulerTick("p21aTick", async () => {
      tickVoucher = (await runInCompanyPostingScope(ctx.companyId, () => insertJournal(`${PREFIX}-TICK`))).id;
    });
    await tick();
    expect(tickVoucher).toBeGreaterThan(0);
    const voucher = await pool.query(`SELECT created_by FROM vouchers WHERE id = $1`, [tickVoucher]);
    expect(voucher.rows[0].created_by).toBe("system:p21aTick");

    // A user acting stays the actor of a posting scope they start.
    const own = await runWithAuditActor(ACTOR, () =>
      runInCompanyPostingScope(ctx.companyId, () => insertJournal(`${PREFIX}-OWN`), "p21a-job")
    );
    expect((await rowAudits("vouchers", own.id))[0].user_id).toBe("p21a-user");
    expect(runAsSystemAuditActor("x", () => 1)).toBe(1);
  });
});

describe("AT3/AT4: retirement keeps the original number and the actor", () => {
  it("sets deleted_by and original_voucher_number, and audits under the request actor", async () => {
    const { id } = await runWithAuditActor(ACTOR, () => insertJournal(`${PREFIX}-RET`));
    await runWithAuditActor({ actorId: "p21a-retirer", actorName: "retirer" }, () =>
      inCompany(() =>
        db.transaction((tx) => retireVouchersTx(tx, { companyId: ctx.companyId, voucherIds: [id], reason: "p21a" }))
      )
    );
    const voucher = await pool.query(
      `SELECT voucher_number, original_voucher_number, created_by, updated_by, deleted_by FROM vouchers WHERE id = $1`,
      [id]
    );
    expect(voucher.rows[0]).toEqual({
      voucher_number: `${PREFIX}-RET~DEL${id}`,
      original_voucher_number: `${PREFIX}-RET`,
      created_by: "p21a-user",
      updated_by: "p21a-retirer",
      deleted_by: "p21a-retirer",
    });
    const app = await pool.query(
      `SELECT user_id, username FROM audit_log WHERE table_name = 'vouchers' AND record_id = $1 AND action = 'delete'`,
      [id]
    );
    expect(app.rows).toEqual([{ user_id: "p21a-retirer", username: "retirer" }]);

    // Restoring clears deleted_by; the original number is kept.
    await runWithAuditActor(ACTOR, () =>
      inCompany(() =>
        db.transaction((tx) =>
          tx.execute(sql`UPDATE vouchers SET deleted_at = NULL, voucher_number = ${`${PREFIX}-RET`} WHERE id = ${id}`)
        )
      )
    );
    const restored = await pool.query(`SELECT original_voucher_number, deleted_by FROM vouchers WHERE id = $1`, [id]);
    expect(restored.rows[0]).toEqual({ original_voucher_number: `${PREFIX}-RET`, deleted_by: null });
  });

  it("fills a missing or 'unknown' application actor from the request context, with the reason", async () => {
    await runWithAuditActor(ACTOR, () =>
      runWithAuditReason("p21a why", () =>
        writeAuditEvent({
          userId: "unknown",
          companyId: ctx.companyId,
          action: "update",
          tableName: "vouchers",
          recordIdentifier: `${PREFIX}-APP`,
        })
      )
    );
    const row = await pool.query(
      `SELECT user_id, username, reason, request_id, ip, session_id FROM audit_log
        WHERE company_id = $1 AND record_identifier = $2`,
      [ctx.companyId, `${PREFIX}-APP`]
    );
    expect(row.rows).toEqual([
      {
        user_id: "p21a-user",
        username: "p21a tester",
        reason: "p21a why",
        request_id: "p21a-request-1",
        ip: "10.21.0.1",
        session_id: ACTOR.sessionHash,
      },
    ]);
  });
});

describe("AT6: a signed-in request carries its metadata to the database", () => {
  it("records the user, request id, IP, session hash and X-Audit-Reason on the trigger rows", async () => {
    const response = await agent
      .post("/api/vouchers/with-entries")
      .set("X-Audit-Reason", "p21a via http")
      .set("X-Request-Id", "p21a-http-request")
      .send({
        voucher: { voucherNumber: `${PREFIX}-HTTP`, voucherType: "Journal", voucherDate: "2026-03-01" },
        entries: [
          { ledgerAccountId: ctx.cashAccountId, debitAmount: "5.00", creditAmount: "0" },
          { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "5.00" },
        ],
      });
    expect(response.status).toBe(200);
    const [header] = await rowAudits("vouchers", response.body.voucher.id);
    expect(header.user_id).toBe(String(ctx.userId));
    expect(header.request_id).toBe("p21a-http-request");
    expect(header.ip).toBeTruthy();
    expect(header.session_id).toMatch(/^[0-9a-f]{64}$/);
    expect(header.reason).toBe("p21a via http");
    const voucher = await pool.query(`SELECT created_by FROM vouchers WHERE id = $1`, [response.body.voucher.id]);
    expect(voucher.rows[0].created_by).toBe(String(ctx.userId));
    // The application row of the same request carries the request id too.
    const app = await pool.query(
      `SELECT request_id FROM audit_log WHERE table_name = 'vouchers' AND record_id = $1 AND action = 'create'`,
      [response.body.voucher.id]
    );
    expect(app.rows.map((row) => row.request_id)).toEqual(["p21a-http-request"]);
  });
});

describe("AT5: retention allow-list and hash chain", () => {
  it("prunes only allow-listed non-financial tables, in code and in the database", async () => {
    for (const table of [
      "vouchers",
      "retail_cash_movements",
      "sp_containers",
      "factory_mix_batches",
      "users",
      "new_table",
    ]) {
      expect(isFinancialAuditTable(table)).toBe(true);
      const result = await pool.query(`SELECT erp_audit_log_is_financial($1) AS financial`, [table]);
      expect(result.rows[0].financial).toBe(true);
    }
    expect(isPrunableAuditTable("remote_support_sessions")).toBe(true);
    const result = await pool.query(`SELECT erp_audit_log_is_financial('remote_support_sessions') AS financial`);
    expect(result.rows[0].financial).toBe(false);
  });

  it("verifies the chain and finds an edited row and a deleted linked row (under a trigger bypass)", async () => {
    await runWithAuditActor(ACTOR, () => insertJournal(`${PREFIX}-CHAIN`, 2));
    const clean = await verifyAuditLogChain({ companyId: ctx.companyId });
    expect(clean.hashMismatch).toBe(0);
    expect(clean.checked).toBeGreaterThan(0);

    const rows = await pool.query<{ id: number }>(
      `SELECT id FROM audit_log WHERE company_id = $1 AND record_identifier LIKE 'voucher:%' AND prev_hash IS NOT NULL
        ORDER BY id DESC LIMIT 3`,
      [ctx.companyId]
    );
    const [newest, middle, oldest] = rows.rows.map((row) => row.id);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`UPDATE audit_log SET username = 'tampered' WHERE id = $1`, [oldest]);
      // Removing a row the next row links to breaks that link.
      await client.query(`DELETE FROM audit_log WHERE id = $1`, [middle]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const tampered = await verifyAuditLogChain({ companyId: ctx.companyId });
    expect(tampered.hashMismatch).toBe(1);
    expect(tampered.brokenLinks).toBeGreaterThanOrEqual(1);
    expect(tampered.failures).toEqual(
      expect.arrayContaining([
        { id: oldest, tableName: "voucher_entries", reason: "hash_mismatch" },
        { id: newest, tableName: "voucher_entries", reason: "broken_link" },
      ])
    );
    const checks = await auditTrailChecks(ctx.companyId);
    expect(checks.find((check) => check.key === "audit_log_hash_chain")?.status).toBe("fail");
  });

  it("lists a disabled audit trigger", async () => {
    await pool.query("ALTER TABLE voucher_entries DISABLE TRIGGER voucher_entries_audit_row_update");
    try {
      const checks = await auditTrailChecks(ctx.companyId);
      const triggers = checks.find((check) => check.key === "audit_trail_triggers");
      expect(triggers?.status).toBe("fail");
      expect(triggers?.samples).toEqual([
        { table: "voucher_entries", trigger: "voucher_entries_audit_row_update", problem: "disabled" },
      ]);
    } finally {
      await pool.query("ALTER TABLE voucher_entries ENABLE TRIGGER voucher_entries_audit_row_update");
    }
  });
});
