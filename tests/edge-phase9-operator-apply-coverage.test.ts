/**
 * Phase 9 manual operator entrypoint: config refusals, reviewer authority,
 * the apply wrapper (stream check, intercompany rebuild only for cancelled
 * sales that applied) and the CLI dispatcher (status / apply / reject /
 * approve / usage). The event store is stubbed at its module boundary; the
 * CLI runs against a fake pool so it never ends the shared one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withRolledBackPool } from "./helpers/routedPoolClient";

const store = vi.hoisted(() => ({
  apply: vi.fn(),
  summarize: vi.fn(),
  decide: vi.fn(),
  recalc: vi.fn(async () => undefined),
}));

vi.mock("../server/edge/phase9CloudEventStore.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/edge/phase9CloudEventStore.mjs")>()),
  applyPendingStagedEvents: (...args: unknown[]) => store.apply(...args),
  summarizePhase9CloudStreams: (...args: unknown[]) => store.summarize(...args),
  recordPhase9ConflictDecision: (...args: unknown[]) => store.decide(...args),
}));
vi.mock("../server/routes/helpers/intercompanyHelpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/routes/helpers/intercompanyHelpers")>()),
  recalculateIntercompanyForDate: (...args: unknown[]) => store.recalc(...(args as [])),
}));

import { pool } from "../server/db";
import {
  assertPhase9Reviewer,
  readPhase9OperatorConfig,
  runPhase9OperatorApply,
} from "../server/edge/phase9OperatorApply";
import { Phase9EventConflict } from "../server/edge/phase9CloudEventStore.mjs";
import { PHASE9_POS_SALE_CANCEL_KIND } from "../server/edge/phase9PosSaleEnvelope.mjs";

const SITE = "11111111-2222-4333-8444-555555555555";
const ENV_KEYS = [
  "FACTORY_EDGE_MODE",
  "FACTORY_CLOUD_WRITE_MODE",
  "FACTORY_CLOUD_FENCE_ACK",
  "FACTORY_SYNC_RECEIVE_ENABLED",
  "FACTORY_PHASE9_APPLY_ENABLED",
  "FACTORY_PHASE8_APPLY_ACK",
  "FACTORY_SYNC_SITE_ID",
  "FACTORY_PHASE8_BASELINE_SHA256",
  "FACTORY_PHASE8_COMPANY_ID",
  "FACTORY_CLOUD_WRITER_EPOCH",
] as const;
const saved: Record<string, string | undefined> = {};

// Mirrors the unexported acknowledgement in server/edge/edgeRuntimePolicy.mjs.
const CLOUD_FENCE_ACK = "CLOUD_WRITES_DISABLED_FOR_FACTORY_HANDOFF";

function validEnv(companyId = 7): Record<string, string> {
  return {
    FACTORY_EDGE_MODE: "cloud",
    FACTORY_CLOUD_WRITE_MODE: "fenced",
    FACTORY_CLOUD_FENCE_ACK: CLOUD_FENCE_ACK,
    FACTORY_SYNC_RECEIVE_ENABLED: "1",
    FACTORY_PHASE9_APPLY_ENABLED: "1",
    FACTORY_PHASE8_APPLY_ACK: "LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED",
    FACTORY_SYNC_SITE_ID: SITE,
    FACTORY_PHASE8_BASELINE_SHA256: "a".repeat(64),
    FACTORY_PHASE8_COMPANY_ID: String(companyId),
    FACTORY_CLOUD_WRITER_EPOCH: "2",
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  store.apply.mockReset();
  store.summarize.mockReset();
  store.decide.mockReset();
  store.recalc.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("readPhase9OperatorConfig", () => {
  it("returns the frozen operator config for a fenced cloud with every acknowledgement", async () => {
    const config = readPhase9OperatorConfig(validEnv(42));
    expect(config).toEqual({
      siteId: SITE,
      companyId: 42,
      cloudEpoch: "2",
      baselineSha256: "a".repeat(64),
      operatorAck: "LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED",
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each([
    ["unfenced cloud", { FACTORY_CLOUD_WRITE_MODE: "primary", FACTORY_CLOUD_FENCE_ACK: "" }],
    ["receive disabled", { FACTORY_SYNC_RECEIVE_ENABLED: "0" }],
    ["apply disabled", { FACTORY_PHASE9_APPLY_ENABLED: "0" }],
    ["wrong operator ack", { FACTORY_PHASE8_APPLY_ACK: "yes" }],
    ["invalid site", { FACTORY_SYNC_SITE_ID: "site-1" }],
    ["invalid baseline", { FACTORY_PHASE8_BASELINE_SHA256: "abc" }],
    ["invalid company", { FACTORY_PHASE8_COMPANY_ID: "0" }],
    ["invalid epoch", { FACTORY_CLOUD_WRITER_EPOCH: "-1" }],
    ["unsafe epoch", { FACTORY_CLOUD_WRITER_EPOCH: "9999999999999999" }],
  ])("refuses when %s", async (_label, override) => {
    const env = { ...validEnv(), ...override };
    expect(() => readPhase9OperatorConfig(env)).toThrow("PHASE9_OPERATOR_APPLICATION_DISABLED");
  });
});

describe("assertPhase9Reviewer", () => {
  it("accepts only active Admin or Developer users of the company", async () => {
    await withRolledBackPool(async (client) => {
      const tag = `p9r${Date.now().toString(36)}`;
      const companyId = (
        await client.query<{ id: number }>(
          `INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`,
          [tag.toUpperCase()]
        )
      ).rows[0].id;
      const user = async (suffix: string, role: string, active = true) => {
        const id = (
          await client.query<{ id: string }>(
            `INSERT INTO users (username, password, active) VALUES ($1, 'x', $2) RETURNING id`,
            [`${tag}_${suffix}`, active]
          )
        ).rows[0].id;
        await client.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, $3)`, [
          id,
          companyId,
          role,
        ]);
      };
      await user("admin", "Admin");
      await user("dev", "Developer");
      await user("mgr", "Manager");
      await user("gone", "Admin", false);
      expect(await assertPhase9Reviewer(pool, companyId, `${tag}_admin`)).toBe(`${tag}_admin`);
      expect(await assertPhase9Reviewer(pool, companyId, `${tag}_dev`)).toBe(`${tag}_dev`);
      for (const name of ["mgr", "gone", "missing"]) {
        await expect(assertPhase9Reviewer(pool, companyId, `${tag}_${name}`)).rejects.toThrow(
          "PHASE9_REVIEWER_NOT_AUTHORIZED"
        );
      }
      await expect(assertPhase9Reviewer(pool, companyId + 999999, `${tag}_admin`)).rejects.toThrow(
        "PHASE9_REVIEWER_NOT_AUTHORIZED"
      );
    });
  });
});

describe("runPhase9OperatorApply", () => {
  it("refuses an unknown stream before reading config", async () => {
    await expect(runPhase9OperatorApply("not-a-stream")).rejects.toThrow("PHASE9_STREAM_INVALID");
    expect(store.apply).not.toHaveBeenCalled();
  });

  it("refuses when operator application is disabled", async () => {
    delete process.env.FACTORY_PHASE9_APPLY_ENABLED;
    await expect(runPhase9OperatorApply("pressing")).rejects.toThrow("PHASE9_OPERATOR_APPLICATION_DISABLED");
    expect(store.apply).not.toHaveBeenCalled();
  });

  it("applies the stream and rebuilds intercompany once per applied cancellation date", async () => {
    Object.assign(process.env, validEnv(9));
    store.apply.mockResolvedValue([
      { kind: PHASE9_POS_SALE_CANCEL_KIND, outcome: "cloud-applied", businessDate: "2026-05-01" },
      { kind: PHASE9_POS_SALE_CANCEL_KIND, outcome: "cloud-applied", businessDate: "2026-05-01" },
      { kind: PHASE9_POS_SALE_CANCEL_KIND, outcome: "rejected-conflict", businessDate: "2026-05-02" },
      { kind: "pos.sale.v1", outcome: "cloud-applied", businessDate: "2026-05-03" },
    ]);
    await withRolledBackPool(async () => {
      const receipts = await runPhase9OperatorApply("pressing");
      expect(receipts).toHaveLength(4);
    });
    const [, input, handlers] = store.apply.mock.calls[0];
    expect(input).toMatchObject({ siteId: SITE, companyId: 9, stream: "pressing", cloudEpoch: "2" });
    expect(Object.keys(handlers as object)).toContain("pressing.confirmation.v1");
    expect(store.recalc.mock.calls).toEqual([[9, "2026-05-01"]]);
  });

  it("releases the client when the store refuses", async () => {
    Object.assign(process.env, validEnv(9));
    store.apply.mockRejectedValue(new Phase9EventConflict("PHASE9_CONFLICT", { sequence: 3 }));
    await withRolledBackPool(async () => {
      await expect(runPhase9OperatorApply("pressing")).rejects.toThrow("PHASE9_CONFLICT");
    });
    expect(store.recalc).not.toHaveBeenCalled();
  });
});

describe("phase9OperatorApply CLI", () => {
  /** Imports the module as the CLI entrypoint against a fake pool and waits for it to finish. */
  async function runCli(args: string[], reviewerRows: Array<{ username: string }> = []) {
    const fakePool = {
      query: vi.fn(async () => ({ rows: reviewerRows })),
      connect: vi.fn(async () => ({ release: vi.fn() })),
      end: vi.fn(async () => undefined),
    };
    const realDb = await import("../server/db");
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const argv = process.argv;
    const exitCode = process.exitCode;
    try {
      vi.resetModules();
      vi.doMock("../server/db", () => ({ ...realDb, pool: fakePool }));
      process.argv = [argv[0], "/srv/server/edge/phase9OperatorApply.ts", ...args];
      await import("../server/edge/phase9OperatorApply");
      await vi.waitFor(() => expect(fakePool.end).toHaveBeenCalled());
      return {
        fakePool,
        exitCode: process.exitCode,
        log: out.mock.calls.map((call) => call.map(String).join(" ")),
        error: err.mock.calls.map((call) => call.map(String).join(" ")),
      };
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      vi.doUnmock("../server/db");
      out.mockRestore();
      err.mockRestore();
    }
  }

  it("prints stream status for a valid site", async () => {
    process.env.FACTORY_SYNC_SITE_ID = SITE;
    store.summarize.mockResolvedValue([{ stream: "pressing", staged: 1 }]);
    const run = await runCli(["status"]);
    expect(run.log).toEqual(['{"phase":9,"result":[{"stream":"pressing","staged":1}]}']);
    expect(store.summarize).toHaveBeenCalledWith(run.fakePool, SITE);
    expect(run.exitCode).toBeUndefined();
  });

  it("refuses status for an invalid site with exit code 1", async () => {
    process.env.FACTORY_SYNC_SITE_ID = "nope";
    const run = await runCli(["status"]);
    expect(run.error).toEqual(["PHASE9_OPERATOR_REFUSED PHASE9_SITE_INVALID "]);
    expect(run.exitCode).toBe(1);
    expect(store.summarize).not.toHaveBeenCalled();
  });

  it("prints usage with exit code 2 for an incomplete command", async () => {
    const run = await runCli(["apply"]);
    expect(run.error[0]).toContain("Usage: node --import tsx server/edge/phase9OperatorApply.ts");
    expect(run.exitCode).toBe(2);
  });

  it("reports a stream conflict with its detail", async () => {
    Object.assign(process.env, validEnv(9));
    const messages: string[] = [];
    store.apply.mockImplementation(async () => {
      // The CLI runs on freshly imported modules; throw that module's conflict class.
      const fresh = await import("../server/edge/phase9CloudEventStore.mjs");
      const conflict = new fresh.Phase9EventConflict("PHASE9_STOCK_BELOW_ZERO", { sequence: 4 });
      messages.push(conflict.message);
      throw conflict;
    });
    const run = await runCli(["apply", "pressing"]);
    expect(run.error).toEqual([`PHASE9_OPERATOR_REFUSED ${messages[0]} [object Object]`]);
    expect(run.exitCode).toBe(1);
  });

  it("refuses a decision for an invalid site, company or reviewer", async () => {
    process.env.FACTORY_SYNC_SITE_ID = "nope";
    let run = await runCli(["reject", "pressing", "3", "boss", "bad", "data"]);
    expect(run.error).toEqual(["PHASE9_OPERATOR_REFUSED PHASE9_SITE_INVALID "]);
    process.env.FACTORY_SYNC_SITE_ID = SITE;
    process.env.FACTORY_PHASE8_COMPANY_ID = "x";
    run = await runCli(["approve", "pressing", "3", "boss", "ok"]);
    expect(run.error).toEqual(["PHASE9_OPERATOR_REFUSED PHASE9_COMPANY_INVALID "]);
    process.env.FACTORY_PHASE8_COMPANY_ID = "12";
    run = await runCli(["approve", "pressing", "3", "boss", "ok"]);
    expect(run.error).toEqual(["PHASE9_OPERATOR_REFUSED PHASE9_REVIEWER_NOT_AUTHORIZED "]);
    expect(store.decide).not.toHaveBeenCalled();
  });

  it("records reject and approve decisions by an authorised reviewer", async () => {
    process.env.FACTORY_SYNC_SITE_ID = SITE;
    process.env.FACTORY_PHASE8_COMPANY_ID = "12";
    store.decide.mockResolvedValue({ recorded: true });
    await runCli(["reject", "pressing", "3", "boss", "bad", "data"], [{ username: "boss" }]);
    const run = await runCli(["approve", "pressing", "4", "boss", "ok"], [{ username: "boss" }]);
    expect(run.fakePool.query.mock.calls[0]).toEqual([expect.any(String), [12, "boss", ["Admin", "Developer"]]]);
    expect(store.decide.mock.calls.map((call) => call[1])).toEqual([
      {
        siteId: SITE,
        stream: "pressing",
        sequence: "3",
        decidedBy: "boss",
        reason: "bad data",
        decision: "reject-event",
      },
      {
        siteId: SITE,
        stream: "pressing",
        sequence: "4",
        decidedBy: "boss",
        reason: "ok",
        decision: "approve-override",
      },
    ]);
    expect(run.log).toEqual(['{"phase":9,"result":{"recorded":true}}']);
  });
});
