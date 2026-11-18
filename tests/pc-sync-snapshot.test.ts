/**
 * Full offline mode (Phase A2): the initial full copy a new PC downloads.
 *
 * Installs the change feed (with its snapshot functions) on a few tables of the
 * test database, then reads the copy through the routes as a signed-in user.
 * Proves: off by default, company isolation, parent-derived rows, no password,
 * paging, refusals, and that copy + feed replay (apply only a higher seq) ends
 * equal to the cloud even when rows change while the copy is being read.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "../server/db";
import { loadPcSyncPolicy, readPublicSchema, resolvePcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import { readPrimaryKeys, renderChangeFeedInstallSql } from "../scripts/pc-sync/changeFeedSql.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `pcsnap_${Date.now()}`;
const FEED_TABLES = ["companies", "locations", "vouchers", "stock_transfer_vouchers", "users", "user_company_roles"];

let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let otherCompanyId: number;
let voucherSeq = 0;

type Row = Record<string, any>;

async function insertVoucher(companyId: number): Promise<number> {
  voucherSeq += 1;
  const { rows } = await pool.query(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Journal', '2026-11-18', 0) RETURNING id`,
    [companyId, `${PREFIX}-${voucherSeq}`]
  );
  return Number(rows[0].id);
}

/** Every row of one table for this user, following `after` until done. */
async function copyTable(table: string, limit?: number): Promise<Row[]> {
  const rows: Row[] = [];
  let after: string | null = null;
  for (let i = 0; i < 500; i += 1) {
    const res = await agent
      .get("/api/offline/pc-sync/snapshot")
      .query({ table, ...(after ? { after } : {}), ...(limit ? { limit } : {}) });
    expect(res.status).toBe(200);
    rows.push(...res.body.rows.map((r: { row: Row }) => r.row));
    after = res.body.after;
    if (!after) return rows;
  }
  throw new Error(`copy of ${table} never finished`);
}

beforeAll(async () => {
  process.env.OFFLINE_PC_SYNC_ENABLED = "1";
  ctx = await seedTestData(PREFIX);
  const other = await pool.query(`INSERT INTO companies (code, name) VALUES ($1, $2) RETURNING id`, [
    `${PREFIX}_B`.slice(0, 40),
    `${PREFIX} other company`,
  ]);
  otherCompanyId = Number(other.rows[0].id);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
});

afterAll(async () => {
  delete process.env.OFFLINE_PC_SYNC_ENABLED;
  await pool.query("DROP SCHEMA IF EXISTS pc_sync CASCADE");
  await pool.query(
    "DELETE FROM stock_transfer_vouchers WHERE voucher_id IN (SELECT id FROM vouchers WHERE voucher_number LIKE $1)",
    [`${PREFIX}-%`]
  );
  await pool.query("DELETE FROM vouchers WHERE voucher_number LIKE $1", [`${PREFIX}-%`]);
  await pool.query("DELETE FROM companies WHERE id = $1", [otherCompanyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
});

describe("PC sync full copy: switched off and not installed", () => {
  it("answers 404 unless OFFLINE_PC_SYNC_ENABLED=1", async () => {
    process.env.OFFLINE_PC_SYNC_ENABLED = "0";
    try {
      expect((await agent.get("/api/offline/pc-sync/snapshot/start")).status).toBe(404);
      expect((await agent.get("/api/offline/pc-sync/snapshot").query({ table: "vouchers" })).status).toBe(404);
    } finally {
      process.env.OFFLINE_PC_SYNC_ENABLED = "1";
    }
  });

  it("answers 503 until a DBA installs the feed", async () => {
    await pool.query("DROP SCHEMA IF EXISTS pc_sync CASCADE");
    const res = await agent.get("/api/offline/pc-sync/snapshot/start");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ code: "OFFLINE_PC_SYNC_NOT_INSTALLED" });
  });
});

describe("PC sync full copy: installed", () => {
  beforeAll(async () => {
    const client = await pool.connect();
    try {
      const { rules, problems } = resolvePcSyncPolicy(loadPcSyncPolicy(), await readPublicSchema(client));
      expect(problems).toEqual([]);
      const subset = new Map(FEED_TABLES.map((table) => [table, rules.get(table)]));
      await client.query(renderChangeFeedInstallSql(subset, await readPrimaryKeys(client)));
    } finally {
      client.release();
    }
  });

  it("starts with a feed cursor, the synced tables and the schema version", async () => {
    const res = await agent.get("/api/offline/pc-sync/snapshot/start");
    expect(res.status).toBe(200);
    expect(res.body.tables).toEqual([...FEED_TABLES].sort());
    expect(typeof res.body.cursor).toBe("string");
    const version = await pool.query("SELECT max(id) AS v FROM schema_migrations");
    expect(res.body.schemaVersion).toBe(version.rows[0].v ?? null);
  });

  it("copies only the user's companies, child rows through their parent, and never the password", async () => {
    const mine = await insertVoucher(ctx.companyId);
    const theirs = await insertVoucher(otherCompanyId);
    await pool.query("INSERT INTO stock_transfer_vouchers (voucher_id, destination_location_id) VALUES ($1, $2)", [
      mine,
      ctx.locationId,
    ]);

    const vouchers = await copyTable("vouchers");
    expect(vouchers.map((v) => v.id)).toContain(mine);
    expect(vouchers.map((v) => v.id)).not.toContain(theirs);
    expect(vouchers.every((v) => v.company_id === ctx.companyId)).toBe(true);

    const children = await copyTable("stock_transfer_vouchers");
    expect(children.map((c) => c.voucher_id)).toContain(mine);

    const users = await copyTable("users");
    expect(users.map((u) => u.id)).toContain(ctx.userId);
    expect(users.every((u) => !("password" in u))).toBe(true);

    const companies = await copyTable("companies");
    expect(companies.map((c) => c.id)).toEqual([ctx.companyId]);
  });

  it("pages a table in key order, every row once", async () => {
    for (let i = 0; i < 5; i += 1) await insertVoucher(ctx.companyId);
    const paged = await copyTable("vouchers", 2);
    const whole = await copyTable("vouchers");
    expect(paged.map((v) => v.id)).toEqual(whole.map((v) => v.id));
    const ids = paged.map((v) => Number(v.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuses a table that is not synced and an `after` it did not issue", async () => {
    const table = await agent.get("/api/offline/pc-sync/snapshot").query({ table: "session" });
    expect(table.status).toBe(422);
    expect(table.body).toEqual({ code: "OFFLINE_PC_SYNC_TABLE_NOT_SYNCED" });
    const bad = await agent.get("/api/offline/pc-sync/snapshot").query({ table: "vouchers", after: "bm90LWpzb24" });
    expect(bad.status).toBe(422);
    expect(bad.body).toEqual({ code: "OFFLINE_PC_SYNC_AFTER_INVALID" });
  });

  it("ends equal to the cloud when rows change while the copy is read (copy + feed replay)", async () => {
    const before = await insertVoucher(ctx.companyId);
    const start = await agent.get("/api/offline/pc-sync/snapshot/start");
    expect(start.status).toBe(200);

    // The PC copies the table while the cloud keeps changing.
    const local = new Map<number, { seq: number; row: Row | null }>();
    for (const row of await copyTable("vouchers")) local.set(Number(row.id), { seq: 0, row });
    await pool.query("UPDATE vouchers SET total_amount = 7 WHERE id = $1", [before]);
    const added = await insertVoucher(ctx.companyId);
    const gone = await insertVoucher(ctx.companyId);
    await pool.query("DELETE FROM vouchers WHERE id = $1", [gone]);

    // Replay the feed from the start cursor: apply only a higher seq per row.
    let cursor = start.body.cursor as string;
    for (let i = 0; i < 50; i += 1) {
      const res = await agent.get("/api/offline/pc-sync/changes").query({ cursor });
      expect(res.status).toBe(200);
      for (const change of res.body.changes) {
        if (change.table !== "vouchers") continue;
        const id = Number(change.key.id);
        if ((local.get(id)?.seq ?? -1) >= change.seq) continue;
        local.set(id, { seq: change.seq, row: change.op === "D" ? null : change.row });
      }
      cursor = res.body.cursor;
      if (res.body.upToDate) break;
    }

    const cloud = await pool.query("SELECT id, total_amount FROM vouchers WHERE company_id = $1 ORDER BY id", [
      ctx.companyId,
    ]);
    const kept = [...local.entries()]
      .filter(([, entry]) => entry.row)
      .map(([id, entry]) => ({ id, total_amount: Number(entry.row!.total_amount) }))
      .sort((a, b) => a.id - b.id);
    expect(kept).toEqual(cloud.rows.map((r) => ({ id: Number(r.id), total_amount: Number(r.total_amount) })));
    expect(kept.find((r) => r.id === before)?.total_amount).toBe(7);
    expect(kept.map((r) => r.id)).toContain(added);
    expect(kept.map((r) => r.id)).not.toContain(gone);
  });
});
