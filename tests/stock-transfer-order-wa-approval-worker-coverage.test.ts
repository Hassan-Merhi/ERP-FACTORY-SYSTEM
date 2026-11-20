/**
 * Durable STO WhatsApp decision worker: the activation switch, the fast-path
 * queue, outcome handling (approved queues deliveries, declined only logs,
 * skips stay quiet, failures back off), the durable sweep against real
 * requested batches, the per-sweep cap, the overlap guard, a failed scan, and
 * worker start-up. The batch executor has its own coverage file; here it is
 * replaced per test, and the WhatsApp delivery queue (outbound) is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  execute: null as null | ((batchId: number) => Promise<unknown>),
  queued: [] as number[],
}));
vi.mock("../server/services/stockTransferOrderWhatsAppBatchExecution", async (importOriginal) => {
  const real = await importOriginal<typeof import("../server/services/stockTransferOrderWhatsAppBatchExecution")>();
  return {
    ...real,
    executeStockTransferOrderWaBatch: (batchId: number) =>
      hoisted.execute ? hoisted.execute(batchId) : real.executeStockTransferOrderWaBatch(batchId),
  };
});
vi.mock("../server/services/stockTransferOrderWaDeliveryWorker", () => ({
  queueStockTransferOrderWaDeliveries: (batchId: number) => hoisted.queued.push(batchId),
}));

import { pool } from "../server/db";
import { logger } from "../server/lib/logger";
import { withRolledBackPool } from "./helpers/routedPoolClient";
import {
  queueStockTransferOrderWaDecision,
  startStockTransferOrderWaApprovalWorker,
  stockTransferOrderWaExecutionEnabled,
  sweepStockTransferOrderWaDecisions,
} from "../server/services/stockTransferOrderWhatsAppApprovalWorker";

const ENV_KEYS = ["STO_WA_PRODUCTION_ACTIVATED", "STO_WA_APPROVAL_EXECUTION_ENABLED", "ENABLE_SCHEDULERS"] as const;
let savedEnv: Record<string, string | undefined> = {};

const enable = () => {
  process.env.STO_WA_PRODUCTION_ACTIVATED = "true";
  process.env.ENABLE_SCHEDULERS = "true";
  delete process.env.STO_WA_APPROVAL_EXECUTION_ENABLED;
};
const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const decided = (batchId: number, outcome: "approved" | "declined") => ({
  outcome,
  batchId,
  orderCount: 1,
  revisionCount: 1,
  appliedRevisions: 1,
  supersededRevisions: 0,
});

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  hoisted.execute = null;
  hoisted.queued = [];
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Leases a stand-in client from the physical pool (the public pool's query
 * wrapper leases through it) so the scan result can be shaped or failed.
 * Scope set-up statements succeed; the batch scan goes to `scan`.
 */
function fakeScan(scan: () => Promise<unknown>) {
  const client = {
    query: (text: unknown) =>
      String(typeof text === "string" ? text : (text as { text?: string })?.text).includes("approval_batches")
        ? scan()
        : Promise.resolve({ rows: [] }),
    release: () => undefined,
  };
  return vi.spyOn(pool, "connect").mockImplementation((async () => client) as never);
}

/** One company with `count` requested batches that each carry a DONE event. */
async function requestedBatches(client: import("pg").PoolClient, count: number): Promise<number[]> {
  const tag = `stowk${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
  const company = await client.query<{ id: number }>("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [
    tag.toUpperCase(),
    `${tag} Co`,
  ]);
  const companyId = company.rows[0].id;
  const location = await client.query<{ id: number }>(
    "INSERT INTO locations(company_id,code,name) VALUES($1,$2,$3) RETURNING id",
    [companyId, `${tag}-DST`, `${tag} DST`]
  );
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const batch = await client.query<{ id: string }>(
      `INSERT INTO stock_transfer_order_approval_batches(company_id,destination_location_id,approval_group_chat_id,
         authorized_phone_e164,created_by,status,requested_at)
       VALUES($1,$2,'120363000000000777@g.us','+243810000777','tester','requested',now()) RETURNING id`,
      [companyId, location.rows[0].id]
    );
    const batchId = Number(batch.rows[0].id);
    await client.query(
      `INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type) VALUES($1,$2,'done_received')`,
      [companyId, batchId]
    );
    ids.push(batchId);
  }
  return ids;
}

describe("activation switch", () => {
  it("requires production activation, schedulers on and execution not disabled", () => {
    enable();
    expect(stockTransferOrderWaExecutionEnabled()).toBe(true);
    process.env.STO_WA_APPROVAL_EXECUTION_ENABLED = "false";
    expect(stockTransferOrderWaExecutionEnabled()).toBe(false);
    enable();
    process.env.ENABLE_SCHEDULERS = "false";
    expect(stockTransferOrderWaExecutionEnabled()).toBe(false);
    enable();
    process.env.STO_WA_PRODUCTION_ACTIVATED = "false";
    expect(stockTransferOrderWaExecutionEnabled()).toBe(false);
  });

  it("does nothing while disabled", async () => {
    process.env.STO_WA_PRODUCTION_ACTIVATED = "false";
    const execute = vi.fn();
    hoisted.execute = execute;
    queueStockTransferOrderWaDecision(5);
    await nextTick();
    expect(await sweepStockTransferOrderWaDecisions()).toBe(0);
    startStockTransferOrderWaApprovalWorker();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("fast-path queue", () => {
  it("ignores invalid batch ids", async () => {
    enable();
    const execute = vi.fn();
    hoisted.execute = execute;
    for (const id of [0, -3, 1.5, Number.NaN]) queueStockTransferOrderWaDecision(id);
    await nextTick();
    expect(execute).not.toHaveBeenCalled();
  });

  it("re-checks the switch when the queued callback runs", async () => {
    enable();
    const execute = vi.fn();
    hoisted.execute = execute;
    queueStockTransferOrderWaDecision(11);
    process.env.STO_WA_PRODUCTION_ACTIVATED = "false";
    await nextTick();
    expect(execute).not.toHaveBeenCalled();
  });

  it("queues deliveries after an approval and logs both decided outcomes", async () => {
    enable();
    const info = vi.spyOn(logger, "info");
    hoisted.execute = async (batchId) => decided(batchId, batchId === 21 ? "approved" : "declined");
    queueStockTransferOrderWaDecision(21);
    queueStockTransferOrderWaDecision(22);
    await nextTick();
    await nextTick();
    expect(hoisted.queued).toEqual([21]);
    const logged = info.mock.calls.filter(([message]) => message === "[STO WA] Full verified decision executed");
    expect(logged.map(([, meta]) => (meta as { outcome: string }).outcome).sort()).toEqual(["approved", "declined"]);
  });

  it("runs the real executor quietly for a batch that does not exist", async () => {
    enable();
    const info = vi.spyOn(logger, "info");
    const error = vi.spyOn(logger, "error");
    queueStockTransferOrderWaDecision(2_000_000_000);
    for (let i = 0; i < 20 && info.mock.calls.length + error.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(hoisted.queued).toEqual([]);
    expect(info.mock.calls.some(([message]) => message === "[STO WA] Full verified decision executed")).toBe(false);
  });
});

describe("durable sweep", () => {
  it("processes requested batches with a decision, backs off failures and skips them on the next sweep", async () => {
    enable();
    const error = vi.spyOn(logger, "error");
    await withRolledBackPool(async (client) => {
      const [failing, passing] = await requestedBatches(client, 2);
      const seen: number[] = [];
      hoisted.execute = async (batchId) => {
        seen.push(batchId);
        if (batchId === failing) throw new Error("transient lock timeout");
        if (batchId === passing) return decided(batchId, "approved");
        return { outcome: "skipped", batchId, reason: "not_mine" };
      };
      const first = await sweepStockTransferOrderWaDecisions();
      expect(first).toBeGreaterThanOrEqual(2);
      expect(seen).toEqual(expect.arrayContaining([failing, passing]));
      expect(hoisted.queued).toContain(passing);
      expect(error).toHaveBeenCalledWith("[STO WA] Verified decision execution deferred; will retry", {
        batchId: failing,
        error: "transient lock timeout",
      });

      seen.length = 0;
      hoisted.execute = async (batchId) => {
        seen.push(batchId);
        throw "not an error object";
      };
      await sweepStockTransferOrderWaDecisions();
      expect(seen).not.toContain(failing);
      expect(seen).toContain(passing);
      expect(error).toHaveBeenCalledWith("[STO WA] Verified decision execution deferred; will retry", {
        batchId: passing,
        error: "unknown_error",
      });
    });
  });

  it("caps one sweep at fifteen batches", async () => {
    enable();
    await withRolledBackPool(async (client) => {
      await requestedBatches(client, 16);
      const execute = vi.fn(async (batchId: number) => ({ outcome: "waiting", batchId, reason: "x" }));
      hoisted.execute = execute;
      expect(await sweepStockTransferOrderWaDecisions()).toBe(15);
      expect(execute).toHaveBeenCalledTimes(15);
    });
  });

  it("skips ids that are not positive safe integers", async () => {
    enable();
    fakeScan(async () => ({ rows: [{ id: "0" }, { id: "abc" }, { id: 7 }] }));
    const execute = vi.fn(async (batchId: number) => ({ outcome: "waiting", batchId, reason: "x" }));
    hoisted.execute = execute;
    expect(await sweepStockTransferOrderWaDecisions()).toBe(1);
    expect(execute).toHaveBeenCalledWith(7);
  });

  it("refuses to overlap a running sweep", async () => {
    enable();
    let release: () => void = () => undefined;
    let scanning = false;
    fakeScan(() => {
      scanning = true;
      return new Promise((resolve) => (release = () => resolve({ rows: [] })));
    });
    const running = sweepStockTransferOrderWaDecisions();
    await vi.waitFor(() => expect(scanning).toBe(true));
    expect(await sweepStockTransferOrderWaDecisions()).toBe(0);
    release();
    expect(await running).toBe(0);
  });

  it("logs and returns zero when the scan fails", async () => {
    enable();
    const error = vi.spyOn(logger, "error");
    const failures: unknown[] = [new Error("connection reset"), "opaque"];
    fakeScan(() => Promise.reject(failures.shift()));
    expect(await sweepStockTransferOrderWaDecisions()).toBe(0);
    expect(await sweepStockTransferOrderWaDecisions()).toBe(0);
    expect(error).toHaveBeenCalledWith("[STO WA] Durable decision scan failed", { error: "connection reset" });
    expect(error).toHaveBeenCalledWith("[STO WA] Durable decision scan failed", { error: "unknown_error" });
  });
});

describe("worker start-up", () => {
  it("starts once with an unref'd interval and an immediate sweep", async () => {
    enable();
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const info = vi.spyOn(logger, "info");
    const query = vi.fn(async () => ({ rows: [] }));
    fakeScan(query);
    startStockTransferOrderWaApprovalWorker();
    startStockTransferOrderWaApprovalWorker();
    expect(info.mock.calls.filter(([message]) => String(message).includes("processor started"))).toHaveLength(1);
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    vi.advanceTimersByTime(20_000);
    await vi.waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
