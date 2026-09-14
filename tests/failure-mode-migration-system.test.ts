import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../server/lib/logger";

const harness = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  poolQuery: vi.fn(),
  markComplete: vi.fn(),
  recordFailures: vi.fn(),
  ssl: vi.fn(),
}));

vi.mock("pg", () => {
  class MockClient {
    _Promise = Promise;
    _queryable = true;
    _connecting = false;
    _ending = false;
    _connected = true;
    _queryQueue = [] as any[];
    connectionParameters = { query_timeout: 0 };
    connect = harness.connect;
    query = harness.query;
    end = harness.end;
  }
  MockClient.prototype.query = harness.query;
  MockClient.prototype.connect = harness.connect;
  MockClient.prototype.end = harness.end;
  return { Client: MockClient, default: { Client: MockClient } };
});

vi.mock("../server/db", () => ({
  pool: { query: harness.poolQuery },
}));

vi.mock("../server/lib/databaseSsl.mjs", () => ({
  resolveDatabaseSsl: harness.ssl,
}));

vi.mock("../server/startupMigrationReport", () => ({
  markStartupMigrationsComplete: harness.markComplete,
  recordStartupMigrationFailures: harness.recordFailures,
}));

import { runStartupMigrations, warmupDb } from "../server/startup/runServerStartupMigrations";
import {
  acquireStartupMigrationLock,
  getMigrationLockOptions,
  releaseStartupMigrationLock,
} from "../server/startupMigrationCoordinator";
// The bilingual-schema contract lives in factory-bilingual-schema-contract.test.ts:
// this file mocks `pg`, which cannot coexist with the bridge's import-time ensure.

function emptyResult() {
  return { rows: [] as any[], rowCount: 0 };
}

function makeMockPgClient(resultRows: any[] = []) {
  return {
    _Promise: Promise,
    _queryable: true,
    _connecting: false,
    _ending: false,
    _connected: true,
    _queryQueue: [] as any[],
    connectionParameters: { query_timeout: 0 },
    _pulseQueryQueue(this: any) {
      const q = this._queryQueue.shift();
      if (q) {
        process.nextTick(() => {
          if (q.callback) {
            q.callback(null, { rows: resultRows, rowCount: resultRows.length });
          }
        });
      }
    },
    connection: {
      query: (query: any) => {
        process.nextTick(() => {
          if (query.callback) {
            query.callback(null, { rows: resultRows, rowCount: resultRows.length });
          }
        });
      },
    },
  };
}

describe("Failure-Mode Suite: Migration & Startup System Failures", () => {
  let loggerInfoSpy: any;
  let loggerWarnSpy: any;
  let loggerErrorSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    loggerInfoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    loggerWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);

    harness.connect.mockResolvedValue(undefined);
    harness.end.mockResolvedValue(undefined);
    harness.query.mockResolvedValue(emptyResult());
    harness.poolQuery.mockResolvedValue(emptyResult());
    harness.ssl.mockReturnValue(false);
  });

  describe("Startup Migration Runner Failure Tolerance", () => {
    it("runs clean migrations and marks complete", async () => {
      const onComplete = vi.fn();
      await runStartupMigrations(["CREATE TABLE IF NOT EXISTS test_tbl (id INT)"], onComplete);

      expect(harness.connect).toHaveBeenCalledTimes(1);
      expect(harness.query).toHaveBeenCalledWith("SET lock_timeout = '30s'");
      expect(harness.query).toHaveBeenCalledWith("SET statement_timeout = '120s'");
      expect(harness.recordFailures).toHaveBeenCalledWith([]);
      expect(harness.markComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("records migration statement failures without crashing startup sweep", async () => {
      harness.query.mockImplementation(async (statement: unknown) => {
        if (String(statement) === "FAILING SQL STATEMENT") {
          const err = new Error("syntax error at or near FAILING");
          Object.assign(err, { code: "42601" });
          throw err;
        }
        return emptyResult();
      });

      const onComplete = vi.fn();
      await runStartupMigrations(["FAILING SQL STATEMENT"], onComplete);

      expect(harness.recordFailures).toHaveBeenCalledWith([
        expect.objectContaining({
          sql: "FAILING SQL STATEMENT",
          error: expect.stringContaining("syntax error"),
        }),
      ]);
      expect(loggerErrorSpy).toHaveBeenCalledWith("✗ 1 migration(s) failed at startup:");
      expect(harness.markComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("rewrites ADD COLUMN IF NOT EXISTS to lock-avoiding DO blocks", async () => {
      await runStartupMigrations(["ALTER TABLE accounts ADD COLUMN IF NOT EXISTS code TEXT"], vi.fn());

      const executedSql = harness.query.mock.calls.map(([stmt]) => String(stmt));
      expect(executedSql.some((stmt) => stmt.includes("DO $mig$ BEGIN"))).toBe(true);
      expect(executedSql.some((stmt) => stmt.includes("information_schema.columns"))).toBe(true);
    });
  });

  describe("Migration Coordinator Advisory Locking & Configuration", () => {
    it("uses safe default migration lock options", () => {
      const opts = getMigrationLockOptions({});
      expect(opts).toEqual({
        waitMs: 90_000,
        pollMs: 1_000,
        failOpen: false,
      });
    });

    it("accepts valid positive timing and fail-open overrides", () => {
      const opts = getMigrationLockOptions({
        STARTUP_MIGRATION_LOCK_WAIT_MS: "60000",
        STARTUP_MIGRATION_LOCK_POLL_MS: "500",
        STARTUP_MIGRATION_LOCK_FAIL_OPEN: "true",
      });
      expect(opts).toEqual({
        waitMs: 60_000,
        pollMs: 500,
        failOpen: true,
      });
    });

    it("falls back to defaults for invalid or negative overrides", () => {
      const opts = getMigrationLockOptions({
        STARTUP_MIGRATION_LOCK_WAIT_MS: "-1000",
        STARTUP_MIGRATION_LOCK_POLL_MS: "invalid-string",
      });
      expect(opts).toEqual({
        waitMs: 90_000,
        pollMs: 1_000,
        failOpen: false,
      });
    });

    it("acquires advisory lock when pg_try_advisory_lock returns true", async () => {
      const mockClient = makeMockPgClient([{ acquired: true }]);

      const acquired = await acquireStartupMigrationLock(mockClient as any, {
        waitMs: 100,
        pollMs: 10,
        failOpen: false,
      });

      expect(acquired).toBe(true);
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        "Startup migration advisory lock acquired",
        expect.objectContaining({ attempts: 1 })
      );
    });

    it("times out when advisory lock cannot be acquired within waitMs", async () => {
      const mockClient = makeMockPgClient([{ acquired: false }]);

      const acquired = await acquireStartupMigrationLock(mockClient as any, {
        waitMs: 30,
        pollMs: 10,
        failOpen: false,
      });

      expect(acquired).toBe(false);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        "Timed out waiting for startup migration advisory lock",
        expect.objectContaining({ failOpen: false })
      );
    });

    it("releases advisory lock cleanly", async () => {
      const mockClient = makeMockPgClient([]);

      await releaseStartupMigrationLock(mockClient as any);
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        "Startup migration advisory lock released",
        expect.objectContaining({ action: "lock-released" })
      );
    });
  });

  describe("Database Warmup Cold-Start Resilience", () => {
    it("succeeds on first attempt when DB is warm", async () => {
      await warmupDb();
      expect(harness.poolQuery).toHaveBeenCalledWith("SELECT 1");
      expect(loggerInfoSpy).toHaveBeenCalledWith("✓ DB connection pool warmed up (attempt 1)");
    });

    it("retries cold start failure and succeeds on attempt 2", async () => {
      vi.useFakeTimers();
      harness.poolQuery
        .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
        .mockResolvedValueOnce(emptyResult());

      const warmupPromise = warmupDb();
      await vi.advanceTimersByTimeAsync(3000);
      await warmupPromise;

      expect(harness.poolQuery).toHaveBeenCalledTimes(2);
      expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining("DB warmup attempt 1 failed"));
      expect(loggerInfoSpy).toHaveBeenCalledWith("✓ DB connection pool warmed up (attempt 2)");
      vi.useRealTimers();
    });

    it("logs failure and allows lazy queries after 3 failed attempts", async () => {
      vi.useFakeTimers();
      harness.poolQuery.mockRejectedValue(new Error("Database host unreachable"));

      const warmupPromise = warmupDb();
      await vi.advanceTimersByTimeAsync(6000);
      await warmupPromise;

      expect(harness.poolQuery).toHaveBeenCalledTimes(3);
      expect(loggerErrorSpy).toHaveBeenCalledWith("✗ DB warmup failed after 3 attempts — queries will connect lazily");
      vi.useRealTimers();
    });
  });
});
