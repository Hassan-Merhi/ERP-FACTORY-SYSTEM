/**
 * Post-startup recurring jobs: container tracking-flag enforcement, migration
 * diagnostics, bale-status fix, export-run orphan and hung-run cleanup and the
 * daily export recovery call. Timers are faked; every query runs inside one
 * rolled-back transaction; modules are reset per test so the module-level
 * `installed` and in-flight guards never leak between tests.
 */
import type { PoolClient, QueryResult } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as dbModule from "../server/db";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const logs = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));
const recovery = vi.hoisted(() => ({ fn: vi.fn(async () => undefined) }));

vi.mock("../server/lib/logger", () => ({
  logger: {
    info: (message: string) => logs.info.push(message),
    warn: (message: string) => logs.warn.push(message),
    error: () => undefined,
    debug: () => undefined,
  },
}));
vi.mock("../server/services/scheduler", () => ({ checkAndRecoverDailyExport: () => recovery.fn() }));

async function freshJobs() {
  vi.resetModules();
  // Keep the already-loaded pool so the rolled-back routing and spies apply.
  vi.doMock("../server/db", () => dbModule);
  return import("../server/startup/postStartupJobs");
}

async function flush() {
  for (let i = 0; i < 20; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Runs `work` with every routed query answered by `answer` instead of the database. */
async function withFakeQueries(answer: (text: string) => Promise<unknown>, work: () => Promise<void>) {
  await withRolledBackPool(async (client) => {
    const spy = vi.spyOn(client, "query").mockImplementation(((text: unknown) => {
      const sql = typeof text === "string" ? text : String((text as { text?: string })?.text);
      // The scoped pool primes and resets session settings around each query.
      if (sql.includes("set_config(")) return Promise.resolve({ rowCount: 1, rows: [{}] });
      return answer(sql);
    }) as never);
    try {
      await work();
    } finally {
      spy.mockRestore();
    }
  });
}

async function idOf(result: Promise<QueryResult<{ id: number }>>): Promise<number> {
  return Number((await result).rows[0].id);
}

beforeEach(() => {
  logs.info.length = 0;
  logs.warn.length = 0;
  recovery.fn.mockReset();
  recovery.fn.mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("runPostStartupJobs", () => {
  it("repairs flags, bale statuses and orphaned or hung export runs, then runs diagnostics and recovery", async () => {
    await withRolledBackPool(async (client) => {
      const tag = `PSJ${Date.now().toString(36)}`.toUpperCase();
      const companyId = await idOf(
        client.query<{ id: number }>(
          `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
          [tag]
        )
      );
      const supplierId = await idOf(
        client.query<{ id: number }>(
          `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'S', 's@example.test') RETURNING id`,
          [companyId, `${tag}S`]
        )
      );
      const erpContainer = await idOf(
        client.query<{ id: number }>(
          `INSERT INTO containers (company_id, container_number, import_date, supplier_id, tracking_enabled)
         VALUES ($1, $2, '2026-01-01', $3, true) RETURNING id`,
          [companyId, `${tag}C`, supplierId]
        )
      );
      const factoryContainer = await idOf(
        client.query<{ id: number }>(
          `INSERT INTO factory_containers (company_id, container_number, tracking_auto_update) VALUES ($1, $2, true) RETURNING id`,
          [companyId, `${tag}F`]
        )
      );
      const bale = await idOf(
        client.query<{ id: number }>(
          `INSERT INTO factory_bales (company_id, reference_number, status, deleted_at) VALUES ($1, $2, 'IN_STOCK', NOW()) RETURNING id`,
          [companyId, `${tag}B`]
        )
      );
      const orphan = await idOf(
        client.query<{ id: number }>(
          `INSERT INTO daily_export_runs (run_type, status, started_at) VALUES ('daily', 'running', NOW() - INTERVAL '10 minutes') RETURNING id`,
          []
        )
      );
      const hung = await idOf(
        client.query<{ id: number }>(
          `INSERT INTO daily_export_runs (run_type, status, started_at) VALUES ('manual', 'running', NOW() - INTERVAL '4 hours') RETURNING id`,
          []
        )
      );
      await client.query(
        `INSERT INTO user_company_roles (user_id, company_id, role)
        SELECT id, $1, 'POS1' FROM users ORDER BY id LIMIT 1`,
        [companyId]
      );

      const { runPostStartupJobs } = await freshJobs();
      runPostStartupJobs();
      runPostStartupJobs(); // second call is a no-op behind the installed guard
      await flush();

      const flags = await client.query(
        `SELECT tracking_enabled, tracking_auto_update FROM containers WHERE id = $1
         UNION ALL SELECT tracking_enabled, tracking_auto_update FROM factory_containers WHERE id = $2`,
        [erpContainer, factoryContainer]
      );
      expect(flags.rows).toEqual([
        { tracking_enabled: false, tracking_auto_update: false },
        { tracking_enabled: false, tracking_auto_update: false },
      ]);
      expect((await client.query(`SELECT status FROM factory_bales WHERE id = $1`, [bale])).rows[0].status).toBe(
        "DELETED"
      );
      expect(logs.info.some((m) => m.includes("[ContainerTracking] Disabled automated tracking"))).toBe(true);
      expect(logs.info.some((m) => m.includes("[BaleStatusFix] Fixed"))).toBe(true);

      await vi.advanceTimersByTimeAsync(3000);
      await flush();
      const runs = await client.query(`SELECT id, status, skipped_reason FROM daily_export_runs WHERE id = ANY($1)`, [
        [orphan, hung],
      ]);
      expect(runs.rows.every((row) => row.status === "failed")).toBe(true);
      expect(logs.info.some((m) => m.includes("Startup: marked"))).toBe(true);

      await vi.advanceTimersByTimeAsync(30000);
      await client.query("SELECT 1");
      await flush();
      expect(logs.info.some((m) => m.includes("[MigrationDiag] POS roles"))).toBe(true);
      expect(logs.warn.some((m) => m.includes("still have old roles"))).toBe(true);

      await vi.advanceTimersByTimeAsync(60000);
      await flush();
      expect(recovery.fn).toHaveBeenCalledTimes(1);

      await client.query(`UPDATE daily_export_runs SET status = 'running' WHERE id = $1`, [hung]);
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      await flush();
      expect((await client.query(`SELECT status FROM daily_export_runs WHERE id = $1`, [hung])).rows[0].status).toBe(
        "failed"
      );
      expect(logs.info.some((m) => m.includes("Periodic: timed out"))).toBe(true);
    });
  });

  it("logs a warning for each job when the database refuses, and skips an overlapping hung-run sweep", async () => {
    const hanging: Array<(value: unknown) => void> = [];
    recovery.fn.mockRejectedValue(new Error("recovery failed"));
    const answer = (text: string) => {
      if (text.includes("3-hour safety limit")) return new Promise((resolve) => hanging.push(resolve));
      return Promise.reject(new Error("db down"));
    };
    await withFakeQueries(answer, async () => {
      const { runPostStartupJobs } = await freshJobs();
      runPostStartupJobs();
      await flush();
      await vi.advanceTimersByTimeAsync(90 * 1000);
      await flush();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await flush();
      expect(logs.warn).toEqual(
        expect.arrayContaining([
          "[ContainerTracking] Could not enforce disabled tracking flags:",
          "[BaleStatusFix] Could not fix inconsistent bale statuses:",
          "[ExportRun] Startup orphan-cleanup failed:",
          "[MigrationDiag] Could not run startup diagnostic:",
          "[DailyExport] Startup recovery call failed:",
          "[ExportRun] Periodic hung-run cleanup skipped because the previous sweep is still running.",
        ])
      );
      expect(hanging).toHaveLength(1);
      hanging[0]({ rowCount: 0, rows: [] });
      await flush();
    });
  });

  it("reports nothing when there is nothing to repair and logs a hung-run failure", async () => {
    let call = 0;
    const answer = (text: string) => {
      if (text.includes("3-hour safety limit")) {
        call += 1;
        return call === 1 ? Promise.reject(new Error("sweep failed")) : Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (text.includes("COUNT(*)")) return Promise.resolve({ rowCount: 1, rows: [{}] });
      return Promise.resolve({ rowCount: 0, rows: [] });
    };
    await withFakeQueries(answer, async () => {
      const { runPostStartupJobs } = await freshJobs();
      runPostStartupJobs();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await flush();
      expect(logs.warn).toEqual(["[ExportRun] Periodic hung-run cleanup failed:"]);
      expect(logs.info).toEqual([expect.stringContaining("can_delete_records column: ✗ MISSING")]);
      expect(call).toBe(2);
    });
  });
});
