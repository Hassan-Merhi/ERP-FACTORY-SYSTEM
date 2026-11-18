/**
 * Full offline mode (Phase A): the cloud change feed a PC downloads.
 *
 * Installs the feed on a few tables of the test database (the way a DBA would,
 * from the same generated SQL), drives real writes and reads pages through the
 * route as a signed-in user. Proves: off by default, company isolation,
 * parent-derived companies, no password ever stored, a row that moves to
 * another company reaches the old one as a key-only removal, a transaction
 * that commits late is never skipped, and paging returns every change once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "../server/db";
import { loadPcSyncPolicy, readPublicSchema, resolvePcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import { readPrimaryKeys, renderChangeFeedInstallSql } from "../scripts/pc-sync/changeFeedSql.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `pcsync_${Date.now()}`;
const FEED_TABLES = ["companies", "locations", "vouchers", "stock_transfer_vouchers", "users", "user_company_roles"];

let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let otherCompanyId: number;
let voucherSeq = 0;

type Change = {
  seq: number;
  txid: string;
  table: string;
  op: string;
  key: Record<string, any>;
  row: Record<string, any> | null;
};

async function insertVoucher(companyId: number, client: { query: typeof pool.query } = pool): Promise<number> {
  voucherSeq += 1;
  const { rows } = await client.query(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Journal', '2026-11-17', 0) RETURNING id`,
    [companyId, `${PREFIX}-${voucherSeq}`]
  );
  return Number(rows[0].id);
}

async function page(cursor?: string, limit?: number) {
  const res = await agent
    .get("/api/offline/pc-sync/changes")
    .query({ ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) });
  return res;
}

/** Reads every page from the cursor until up to date. */
async function readAll(cursor: string, limit?: number): Promise<{ changes: Change[]; cursor: string }> {
  const changes: Change[] = [];
  for (let i = 0; i < 50; i += 1) {
    const res = await page(cursor, limit);
    expect(res.status).toBe(200);
    changes.push(...res.body.changes);
    cursor = res.body.cursor;
    if (res.body.upToDate) return { changes, cursor };
  }
  throw new Error("feed never reached the watermark");
}

const ids = (changes: Change[], table: string) =>
  changes.filter((c) => c.table === table && c.op !== "T").map((c) => Number(c.key.id ?? c.key.voucher_id));

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

describe("PC sync change feed: switched off and not installed", () => {
  it("answers 404 unless OFFLINE_PC_SYNC_ENABLED=1", async () => {
    process.env.OFFLINE_PC_SYNC_ENABLED = "0";
    try {
      const res = await page();
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ code: "OFFLINE_PC_SYNC_DISABLED" });
    } finally {
      process.env.OFFLINE_PC_SYNC_ENABLED = "1";
    }
  });

  it("answers 503 until a DBA installs the feed", async () => {
    await pool.query("DROP SCHEMA IF EXISTS pc_sync CASCADE");
    const res = await page();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ code: "OFFLINE_PC_SYNC_NOT_INSTALLED" });
  });
});

describe("PC sync change feed: installed", () => {
  let cursor: string;

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
    const start = await readAll("");
    cursor = start.cursor;
  });

  it("sends only the user's companies, finds a child row's company through its parent, and never the password", async () => {
    const mine = await insertVoucher(ctx.companyId);
    const theirs = await insertVoucher(otherCompanyId);
    await pool.query("INSERT INTO stock_transfer_vouchers (voucher_id, destination_location_id) VALUES ($1, $2)", [
      mine,
      ctx.locationId,
    ]);
    await pool.query("UPDATE users SET active = true WHERE id = $1", [ctx.userId]);

    const { changes, cursor: next } = await readAll(cursor);
    cursor = next;
    expect(ids(changes, "vouchers")).toEqual([mine]);
    expect(ids(changes, "vouchers")).not.toContain(theirs);
    const child = changes.find((c) => c.table === "stock_transfer_vouchers");
    expect(child).toMatchObject({ op: "I" });
    expect(child?.row?.voucher_id).toBe(mine);
    const user = changes.find((c) => c.table === "users" && c.key.id === ctx.userId);
    expect(user?.op).toBe("U");
    expect(user?.row).not.toHaveProperty("password");
    expect(JSON.stringify(changes)).not.toContain("$2"); // no bcrypt hash anywhere

    const stored = await pool.query("SELECT count(*)::int AS n FROM pc_sync.changes WHERE row_data ? 'password'");
    expect(stored.rows[0].n).toBe(0);
  });

  it("tells the old company a moved row left, without sending the new company's data", async () => {
    const voucherId = await insertVoucher(ctx.companyId);
    ({ cursor } = await readAll(cursor));
    await pool.query("UPDATE vouchers SET company_id = $1, total_amount = 99 WHERE id = $2", [
      otherCompanyId,
      voucherId,
    ]);

    const { changes, cursor: next } = await readAll(cursor);
    cursor = next;
    const moved = changes.filter((c) => c.table === "vouchers" && Number(c.key?.id) === voucherId);
    expect(moved).toEqual([expect.objectContaining({ op: "D", row: null, key: { id: voucherId } })]);
    // Rows that find their company through the voucher moved with it: every PC copies that table again.
    expect(changes.filter((c) => c.op === "T").map((c) => c.table)).toEqual(["stock_transfer_vouchers"]);
  });

  it("reads a full 1000-change page without ending the window early", async () => {
    await pool.query(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
       SELECT $1, $2 || '-bulk-' || g, 'Journal', '2026-11-17', 0 FROM generate_series(1, 1001) AS g`,
      [ctx.companyId, PREFIX]
    );
    const first = await page(cursor, 1000);
    expect(first.status).toBe(200);
    expect(first.body.changes).toHaveLength(1000);
    expect(first.body.upToDate).toBe(false);
    const rest = await readAll(first.body.cursor, 1000);
    cursor = rest.cursor;
    expect(first.body.changes.length + rest.changes.length).toBe(1001);
  });

  it("never skips a transaction that commits after a later one", async () => {
    const slow = await pool.connect();
    try {
      await slow.query("BEGIN");
      const early = await insertVoucher(ctx.companyId, slow); // older transaction, still open
      const late = await insertVoucher(ctx.companyId); // newer transaction, committed

      const whileOpen = await readAll(cursor);
      // The watermark stops below the open transaction, so the committed newer one waits too.
      expect(ids(whileOpen.changes, "vouchers")).toEqual([]);

      await slow.query("COMMIT");
      const after = await readAll(whileOpen.cursor);
      cursor = after.cursor;
      expect(ids(after.changes, "vouchers")).toEqual([early, late]);
    } finally {
      await slow.query("ROLLBACK").catch(() => undefined);
      slow.release();
    }
  });

  it("gives the later write to a row the higher seq, even when it arrives first", async () => {
    const voucherId = await insertVoucher(ctx.companyId);
    ({ cursor } = await readAll(cursor));
    const late = await pool.connect();
    try {
      await late.query("BEGIN");
      await insertVoucher(ctx.companyId, late); // takes the lower transaction id
      await pool.query("UPDATE vouchers SET total_amount = 1 WHERE id = $1", [voucherId]); // newer id, commits first
      await late.query("UPDATE vouchers SET total_amount = 2 WHERE id = $1", [voucherId]); // the real final write
      await late.query("COMMIT");
    } finally {
      await late.query("ROLLBACK").catch(() => undefined);
      late.release();
    }

    const { changes, cursor: next } = await readAll(cursor);
    cursor = next;
    const updates = changes.filter((c) => c.table === "vouchers" && c.op === "U" && Number(c.key.id) === voucherId);
    expect(updates).toHaveLength(2);
    // Delivered in transaction order: the final write (2) comes first...
    expect(updates.map((c) => Number(c.row?.total_amount))).toEqual([2, 1]);
    // ...but it has the higher seq, so "apply only a higher seq" keeps 2.
    const winner = updates.reduce((a, b) => (b.seq > a.seq ? b : a));
    expect(Number(winner.row?.total_amount)).toBe(2);
  });

  it("returns every change exactly once across pages, in order", async () => {
    const created: number[] = [];
    for (let i = 0; i < 5; i += 1) created.push(await insertVoucher(ctx.companyId));

    const { changes, cursor: next } = await readAll(cursor, 2);
    cursor = next;
    expect(ids(changes, "vouchers")).toEqual(created);
    const seqs = changes.map((c) => c.seq);
    expect(new Set(seqs).size).toBe(seqs.length);

    const again = await readAll(cursor);
    expect(again.changes).toEqual([]);
  });

  it("refuses a cursor it did not issue", async () => {
    const res = await page("bm90LWEtY3Vyc29y");
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: "OFFLINE_PC_SYNC_CURSOR_INVALID" });
  });
});
