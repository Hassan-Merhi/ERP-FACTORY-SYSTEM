/**
 * Full offline mode (Phase A3): a PC's local database kept equal to the cloud.
 *
 * The cloud is the test database with the change feed installed on a few
 * tables; the PC is a second, disposable database built from migrations/. The
 * agent signs in as a normal user and copies, then replays the feed. Proves:
 * schema mismatch refused, only the user's companies, resume after an
 * interrupted copy, inserts/updates/deletes/moves follow, a TRUNCATE recopies
 * the table, offline sign-in uses only hashes made on this PC, the 24h/2-day
 * freshness rule, and the local server refuses writes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import { pool } from "../server/db";
import { loadPcSyncPolicy, readPublicSchema, resolvePcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import { readPrimaryKeys, renderChangeFeedInstallSql } from "../scripts/pc-sync/changeFeedSql.mjs";
import { prepareLocalDatabase } from "../scripts/pc-sync/local/localStore.mjs";
import {
  bindCloudAccount,
  pcSyncFreshness,
  rememberLocalLogin,
  syncOnce,
} from "../scripts/pc-sync/local/syncAgent.mjs";
import { createCloudClient } from "../scripts/pc-sync/local/cloudClient.mjs";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { applyPcLocalModeEnvironment } from "../server/offline/pcLocal/localReadOnlyGuard";
import { applyMigrations, databaseUrlFor } from "./helpers/migrateDisposableDatabase.mjs";
import { cleanupTestData, closeTestServer, seedTestData, setupTestApp, type TestContext } from "./setup";

const PREFIX = `pclocal_${Date.now()}`;
const LOCAL_DB = "pcsync_local_agent_test";
const FEED_TABLES = ["companies", "locations", "vouchers", "stock_transfer_vouchers", "users", "user_company_roles"];

let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let otherCompanyId: number;
let admin: Client;
let local: Client;
let voucherSeq = 0;

type Cloud = { get(path: string, query?: Record<string, unknown>): Promise<{ status: number; body: any }> };
const cloud: Cloud = {
  async get(path, query) {
    const res = await agent.get(path).query(query ?? {});
    return { status: res.status, body: res.body };
  },
};

async function insertVoucher(companyId: number): Promise<number> {
  voucherSeq += 1;
  const { rows } = await pool.query(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Journal', '2026-11-18', 0) RETURNING id`,
    [companyId, `${PREFIX}-${voucherSeq}`]
  );
  return Number(rows[0].id);
}

async function localVouchers() {
  const { rows } = await local.query("SELECT id, company_id, total_amount FROM vouchers ORDER BY id");
  return rows.map((r) => ({ id: Number(r.id), company_id: Number(r.company_id), total: Number(r.total_amount) }));
}

async function cloudVouchers() {
  const { rows } = await pool.query(
    "SELECT id, company_id, total_amount FROM vouchers WHERE company_id = $1 ORDER BY id",
    [ctx.companyId]
  );
  return rows.map((r) => ({ id: Number(r.id), company_id: Number(r.company_id), total: Number(r.total_amount) }));
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

  // Cloud: the change feed on a few tables, installed the way a DBA would.
  const client = await pool.connect();
  try {
    const { rules, problems } = resolvePcSyncPolicy(loadPcSyncPolicy(), await readPublicSchema(client));
    expect(problems).toEqual([]);
    const subset = new Map(FEED_TABLES.map((table) => [table, rules.get(table)]));
    await client.query(renderChangeFeedInstallSql(subset, await readPrimaryKeys(client)));
  } finally {
    client.release();
  }

  // PC: an empty database built from migrations/ only.
  admin = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS pcsync_local_agent_test WITH (FORCE)");
  await admin.query("CREATE DATABASE pcsync_local_agent_test");
  const localUrl = databaseUrlFor(process.env.DATABASE_URL!, LOCAL_DB);
  applyMigrations(localUrl);
  local = new Client({ connectionString: localUrl, ssl: false });
  await local.connect();
  await prepareLocalDatabase(local, loadPcSyncPolicy().redact);
}, 120_000);

afterAll(async () => {
  delete process.env.OFFLINE_PC_SYNC_ENABLED;
  await local?.end().catch(() => undefined);
  await admin?.query("DROP DATABASE IF EXISTS pcsync_local_agent_test WITH (FORCE)").catch(() => undefined);
  await admin?.end().catch(() => undefined);
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

describe("PC local copy: sync agent", () => {
  it("refuses to load when the cloud's schema version differs from the PC's", async () => {
    const wrongSchema: Cloud = {
      async get(path, query) {
        const res = await cloud.get(path, query);
        if (path.endsWith("/snapshot/start")) res.body = { ...res.body, schemaVersion: "9999_not_this_pc" };
        return res;
      },
    };
    await expect(syncOnce(local, wrongSchema)).rejects.toMatchObject({ code: "PC_LOCAL_SCHEMA_MISMATCH" });
    const { rows } = await local.query("SELECT cursor FROM pc_local.state");
    expect(rows[0].cursor).toBeNull();
  });

  it("resumes an interrupted copy and ends with only the user's companies, no password", async () => {
    const mine = [await insertVoucher(ctx.companyId), await insertVoucher(ctx.companyId)];
    const theirs = await insertVoucher(otherCompanyId);
    await pool.query("INSERT INTO stock_transfer_vouchers (voucher_id, destination_location_id) VALUES ($1, $2)", [
      mine[0],
      ctx.locationId,
    ]);

    const partial = await syncOnce(local, cloud, { pageSize: 1, maxPages: 3 });
    expect(partial.upToDate).toBe(false);
    const progress = await local.query("SELECT count(*) FILTER (WHERE done)::int AS done FROM pc_local.copy_progress");
    expect(progress.rows[0].done).toBeLessThan(FEED_TABLES.length);

    const full = await syncOnce(local, cloud, { pageSize: 2 });
    expect(full.upToDate).toBe(true);
    expect(await localVouchers()).toEqual(await cloudVouchers());
    expect((await localVouchers()).map((v) => v.id)).not.toContain(theirs);

    const companies = await local.query("SELECT id FROM companies ORDER BY id");
    expect(companies.rows.map((r) => Number(r.id))).toEqual([ctx.companyId]);
    const child = await local.query("SELECT voucher_id FROM stock_transfer_vouchers");
    expect(child.rows.map((r) => Number(r.voucher_id))).toEqual([mine[0]]);
    const user = await local.query("SELECT password FROM users WHERE id = $1", [ctx.userId]);
    expect(user.rows[0].password).toBe("!"); // never signed in on this PC: no password works
    const state = await local.query("SELECT copy_complete, last_sync_at FROM pc_local.state");
    expect(state.rows[0].copy_complete).toBe(true);
    expect(state.rows[0].last_sync_at).not.toBeNull();
  });

  it("follows inserts, updates, deletes and a row moved to another company", async () => {
    const [changed, removed, moved] = [
      await insertVoucher(ctx.companyId),
      await insertVoucher(ctx.companyId),
      await insertVoucher(ctx.companyId),
    ];
    await syncOnce(local, cloud);
    await pool.query("UPDATE vouchers SET total_amount = 42 WHERE id = $1", [changed]);
    await pool.query("DELETE FROM vouchers WHERE id = $1", [removed]);
    await pool.query("UPDATE vouchers SET company_id = $1 WHERE id = $2", [otherCompanyId, moved]);
    const added = await insertVoucher(ctx.companyId);

    const report = await syncOnce(local, cloud);
    expect(report.upToDate).toBe(true);
    const rows = await localVouchers();
    expect(rows).toEqual(await cloudVouchers());
    expect(rows.find((v) => v.id === changed)?.total).toBe(42);
    expect(rows.map((v) => v.id)).toEqual(expect.arrayContaining([added]));
    expect(rows.map((v) => v.id)).not.toContain(removed);
    expect(rows.map((v) => v.id)).not.toContain(moved);
  });

  it("empties and copies again a table the cloud truncated", async () => {
    const page = await local.query("SELECT cursor FROM pc_local.state");
    // A stale local row the cloud no longer has: the reload must remove it.
    await local.query(`BEGIN; SET LOCAL session_replication_role = replica;
      INSERT INTO stock_transfer_vouchers (voucher_id, destination_location_id) VALUES (-1, -1); COMMIT;`);
    const truncating: Cloud = {
      async get(path, query) {
        const res = await cloud.get(path, query);
        if (path.endsWith("/changes") && query?.cursor === page.rows[0].cursor) {
          res.body = {
            ...res.body,
            changes: [
              { seq: 1, txid: "1", table: "stock_transfer_vouchers", op: "T", key: null, row: null },
              ...res.body.changes,
            ],
          };
        }
        return res;
      },
    };
    const report = await syncOnce(local, truncating);
    expect(report.upToDate).toBe(true);
    const rows = await local.query("SELECT voucher_id FROM stock_transfer_vouchers ORDER BY voucher_id");
    const cloudRows = await pool.query(
      `SELECT s.voucher_id FROM stock_transfer_vouchers s JOIN vouchers v ON v.id = s.voucher_id
        WHERE v.company_id = $1 ORDER BY s.voucher_id`,
      [ctx.companyId]
    );
    expect(rows.rows.map((r) => Number(r.voucher_id))).toEqual(cloudRows.rows.map((r) => Number(r.voucher_id)));
  });

  it("stops resuming once the cloud's schema moves on (the desktop app must be updated first)", async () => {
    const migrated: Cloud = {
      async get(path, query) {
        const res = await cloud.get(path, query);
        if (path.endsWith("/snapshot/start")) res.body = { ...res.body, schemaVersion: "9999_newer_cloud" };
        return res;
      },
    };
    const before = await local.query("SELECT cursor FROM pc_local.state");
    await expect(syncOnce(local, migrated)).rejects.toMatchObject({ code: "PC_LOCAL_SCHEMA_MISMATCH" });
    const after = await local.query("SELECT cursor FROM pc_local.state");
    expect(after.rows[0].cursor).toBe(before.rows[0].cursor); // nothing applied
  });

  it("lets only someone who signed in on this PC sign in offline, and keeps that hash across syncs", async () => {
    await rememberLocalLogin(local, ctx.userId, "testpassword123");
    await pool.query("UPDATE users SET active = true WHERE id = $1", [ctx.userId]);
    await syncOnce(local, cloud);
    const { rows } = await local.query("SELECT password FROM users WHERE id = $1", [ctx.userId]);
    expect(await bcrypt.compare("testpassword123", rows[0].password)).toBe(true);
    expect(await bcrypt.compare("wrong", rows[0].password)).toBe(false);
    const cloudHash = await pool.query("SELECT password FROM users WHERE id = $1", [ctx.userId]);
    expect(rows[0].password).not.toBe(cloudHash.rows[0].password); // the cloud's hash never reached the PC
  });
});

describe("PC local copy: bound to one cloud account", () => {
  it("keeps the copy for the same account and starts again for a different one", async () => {
    expect(await bindCloudAccount(local, ctx.userId)).toBe(false); // first binding
    expect(await bindCloudAccount(local, ctx.userId)).toBe(false); // same account
    expect((await localVouchers()).length).toBeGreaterThan(0);

    expect(await bindCloudAccount(local, "another-account")).toBe(true);
    expect(await localVouchers()).toEqual([]);
    const state = await local.query("SELECT cursor, copy_complete, last_sync_at, cloud_user_id FROM pc_local.state");
    expect(state.rows[0]).toEqual({
      cursor: null,
      copy_complete: false,
      last_sync_at: null,
      cloud_user_id: "another-account",
    });

    // Back to the real account: a full copy again, equal to the cloud.
    await bindCloudAccount(local, ctx.userId);
    expect((await syncOnce(local, cloud)).upToDate).toBe(true);
    expect(await localVouchers()).toEqual(await cloudVouchers());
  });
});

describe("PC local copy: cloud connection", () => {
  it("signs in over HTTP, keeps only the session cookie and reads the feed with it", async () => {
    const server = ctx.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = createCloudClient(`http://127.0.0.1:${port}`);
      await expect(client.login(`${PREFIX}_testuser`, "wrong-password")).rejects.toMatchObject({
        code: "PC_SYNC_LOGIN_REFUSED",
      });
      expect(await client.login(`${PREFIX}_testuser`, "testpassword123")).toBe(ctx.userId);
      expect(client.cookie()).not.toContain("testpassword123");
      const page = await client.get("/api/offline/pc-sync/changes", {});
      expect(page.status).toBe(200);
      expect(Array.isArray(page.body.changes)).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses a plain-http cloud address and paths outside the API", () => {
    expect(() => createCloudClient("http://example.com")).toThrow("PC_SYNC_CLOUD_URL_INSECURE");
    const client = createCloudClient("https://example.com", {
      fetch: (() => Promise.reject(new Error("no"))) as never,
    });
    return expect(client.get("//evil.example/api/x")).rejects.toMatchObject({ code: "PC_SYNC_CLOUD_PATH_INVALID" });
  });
});

describe("PC local copy: the agent process the desktop app runs", () => {
  it("builds the PC database, signs in, copies and reports status without leaking the password", async () => {
    await admin.query("DROP DATABASE IF EXISTS pcsync_local_agent_proc WITH (FORCE)");
    await admin.query("CREATE DATABASE pcsync_local_agent_proc");
    const server = ctx.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const child = spawn(process.execPath, ["scripts/pc-sync/local/run-agent.mjs"], {
      env: {
        ...process.env,
        PC_LOCAL_DATABASE_URL: databaseUrlFor(process.env.DATABASE_URL!, "pcsync_local_agent_proc"),
        PC_SYNC_CLOUD_URL: `http://127.0.0.1:${port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events: any[] = [];
    let raw = "";
    const waiters: Array<{ test: (e: any) => boolean; resolve: (e: any) => void }> = [];
    createInterface({ input: child.stdout! }).on("line", (line) => {
      raw += line;
      const event = JSON.parse(line);
      events.push(event);
      for (const w of [...waiters]) {
        if (!w.test(event)) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(event);
      }
    });
    const next = (test: (e: any) => boolean) =>
      new Promise<any>((resolve, reject) => {
        const found = events.find(test);
        if (found) return resolve(found);
        waiters.push({ test, resolve });
        setTimeout(() => reject(new Error(`no event; got ${JSON.stringify(events)}`)), 60_000).unref();
      });
    try {
      expect(await next((e) => e.event === "status")).toMatchObject({ needsLogin: true });
      child.stdin!.write(
        `${JSON.stringify({ cmd: "login", username: `${PREFIX}_testuser`, password: "testpassword123" })}\n`
      );
      expect(await next((e) => e.event === "login")).toMatchObject({ event: "login", ok: true });
      const done = await next((e) => e.event === "status" && e.copyComplete && e.lastSyncAt);
      expect(done.freshness.level).toBe("current");
      expect(raw).not.toContain("testpassword123");

      const pcDb = new Client({
        connectionString: databaseUrlFor(process.env.DATABASE_URL!, "pcsync_local_agent_proc"),
        ssl: false,
      });
      await pcDb.connect();
      try {
        const { rows } = await pcDb.query("SELECT id FROM vouchers ORDER BY id");
        expect(rows.map((r) => Number(r.id))).toEqual((await cloudVouchers()).map((v) => v.id));
      } finally {
        await pcDb.end();
      }
      child.stdin!.write(`${JSON.stringify({ cmd: "stop" })}\n`);
      await new Promise((resolve) => child.once("exit", resolve));
    } finally {
      child.kill();
      await new Promise((resolve) => server.close(resolve));
      await admin.query("DROP DATABASE IF EXISTS pcsync_local_agent_proc WITH (FORCE)");
    }
  }, 120_000);
});

describe("PC local copy: freshness and read-only server", () => {
  it("warns after 24 hours without a sync and stops new entries after 2 days", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(pcSyncFreshness(null, now)).toMatchObject({ level: "never", blockNewEntries: true });
    expect(pcSyncFreshness(new Date("2026-11-18T00:00:00Z"), now)).toMatchObject({ level: "current", warn: false });
    expect(pcSyncFreshness(new Date("2026-11-17T11:00:00Z"), now)).toMatchObject({ level: "warn", warn: true });
    expect(pcSyncFreshness(new Date("2026-11-16T11:00:00Z"), now)).toMatchObject({
      level: "blocked",
      blockNewEntries: true,
    });
  });

  it("switches off background jobs in local mode only", () => {
    const cloudEnv: NodeJS.ProcessEnv = {};
    expect(applyPcLocalModeEnvironment(cloudEnv)).toBe(false);
    expect(cloudEnv.ENABLE_SCHEDULERS).toBeUndefined();
    const pcEnv: NodeJS.ProcessEnv = { OFFLINE_PC_LOCAL_MODE: "read-only", ENABLE_SCHEDULERS: "true" };
    expect(applyPcLocalModeEnvironment(pcEnv)).toBe(true);
    expect(pcEnv.ENABLE_SCHEDULERS).toBe("false");
  });

  it("sends the session cookie over the PC's plain-http loopback, and only there", async () => {
    const { buildSessionMiddleware } = await import("../server/startup/sessionMiddleware");
    const saved = { ...process.env };
    const cookieFor = async (env: Record<string, string>) => {
      Object.assign(process.env, env);
      try {
        const app = express();
        app.use(buildSessionMiddleware());
        app.get("/touch", (req, res) => {
          (req.session as unknown as Record<string, unknown>).touched = true;
          res.end();
        });
        const res = await request(app).get("/touch");
        return String(res.headers["set-cookie"] ?? "");
      } finally {
        for (const key of Object.keys(env)) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    };
    const base = { NODE_ENV: "production", SESSION_SECRET: "s".repeat(64) };
    const local = await cookieFor({ ...base, OFFLINE_PC_LOCAL_MODE: "read-only" });
    expect(local).toMatch(/=/); // set over plain http on the loopback
    expect(local).not.toMatch(/;\s*Secure/i);
    // The cloud (no local mode) keeps its secure cookie.
    const cloudApp = express();
    Object.assign(process.env, base);
    try {
      cloudApp.set("trust proxy", 1);
      cloudApp.use(buildSessionMiddleware());
      cloudApp.get("/touch", (req, res) => {
        (req.session as unknown as Record<string, unknown>).touched = true;
        res.end();
      });
      const res = await request(cloudApp).get("/touch").set("X-Forwarded-Proto", "https");
      expect(String(res.headers["set-cookie"] ?? "")).toMatch(/;\s*Secure/i);
    } finally {
      process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = saved.SESSION_SECRET;
    }
  });

  it("refuses writes on the local copy but allows reading and signing in", async () => {
    const app = await setupTestApp({ pcLocalGuard: true });
    const pc = request.agent(app);
    process.env.OFFLINE_PC_LOCAL_MODE = "read-only";
    try {
      const login = await pc
        .post("/api/auth/login")
        .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
      expect(login.status).toBe(200);
      const write = await pc.post("/api/vouchers").send({});
      expect(write.status).toBe(423);
      expect(write.body).toEqual({ code: "OFFLINE_PC_LOCAL_READ_ONLY" });
      const read = await pc.get("/api/auth/me");
      expect(read.status).not.toBe(423);
    } finally {
      delete process.env.OFFLINE_PC_LOCAL_MODE;
    }
    // Without the flag (the cloud) the same write reaches its route.
    const cloudWrite = await pc.post("/api/vouchers").send({});
    expect(cloudWrite.status).not.toBe(423);
  });
});
