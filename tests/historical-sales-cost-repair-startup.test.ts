/**
 * maybeRunHistoricalSalesCostRepairFromEnv lets an operator run the repair
 * from a deploy's environment. It must do nothing unless asked, validate
 * every identifier before touching the database, refuse a run whose audit
 * hash does not match, refuse writes after the perpetual-inventory cut-over,
 * and keep a deploy healthy when a dry run is refused for an active partial
 * apply.
 */
const harness = vi.hoisted(() => ({
  dryRun: vi.fn(),
  apply: vi.fn(),
  getRun: vi.fn(),
  preview: vi.fn(),
  partial: vi.fn(),
  rollback: vi.fn(),
  verify: vi.fn(),
  cutover: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../server/lib/logger", () => ({ logger: harness.logger }));
vi.mock("../server/services/inventory/historicalSalesCostCutoverGuard", () => ({
  assertRunBeforeCutover: harness.cutover,
}));
vi.mock("../server/services/inventory/historicalSalesCostRepair", () => ({
  applyHistoricalSalesCostRepair: harness.apply,
  buildHistoricalSalesCostRepairDryRun: harness.dryRun,
  getHistoricalSalesCostRepairRun: harness.getRun,
}));
vi.mock("../server/services/inventory/historicalSalesCostPartialApply", () => ({
  HISTORICAL_SALES_COST_PARTIAL_APPLY_MODE: "proven-rows-only",
  applyHistoricalSalesCostPartial: harness.partial,
  previewHistoricalSalesCostPartialApply: harness.preview,
  rollbackHistoricalSalesCostPartial: harness.rollback,
  verifyHistoricalSalesCostPartialApply: harness.verify,
}));

import { maybeRunHistoricalSalesCostRepairFromEnv as run } from "../server/services/inventory/historicalSalesCostRepairStartup";

const HASH = "a".repeat(64);
const TARGET = "b".repeat(64);
const ENV_KEYS = [
  "HISTORICAL_SALES_COST_REPAIR_MODE",
  "HISTORICAL_SALES_COST_REPAIR_RUN_ID",
  "HISTORICAL_SALES_COST_REPAIR_AUDIT_HASH",
  "HISTORICAL_SALES_COST_REPAIR_COMPANY_IDS",
  "HISTORICAL_SALES_COST_REPAIR_TARGET_HASH",
  "HISTORICAL_SALES_COST_REPAIR_PARTIAL_CONFIRMATION",
  "HISTORICAL_SALES_COST_REPAIR_ROLLBACK_CONFIRMATION",
];

function env(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) process.env[`HISTORICAL_SALES_COST_REPAIR_${key}`] = value;
}

const calledWriters = () =>
  [harness.dryRun, harness.apply, harness.partial, harness.rollback].filter((fn) => fn.mock.calls.length > 0).length;

beforeEach(() => {
  for (const fn of [harness.dryRun, harness.apply, harness.getRun, harness.preview, harness.partial, harness.rollback])
    fn.mockReset();
  harness.verify
    .mockReset()
    .mockResolvedValue({ ok: true, rowsAtOriginal: 3, rowsAtProposed: 3, cogs: "1", profit: "2" });
  harness.cutover.mockReset().mockResolvedValue(undefined);
  harness.logger.info.mockReset();
  harness.logger.error.mockReset();
});
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("historical sales cost repair from the environment", () => {
  it.each(["", "off", " Disabled "])("does nothing when the mode is %j", async (mode) => {
    env({ MODE: mode });

    await run();

    expect(calledWriters()).toBe(0);
    expect(harness.getRun).not.toHaveBeenCalled();
  });

  it("rejects an unknown mode", async () => {
    env({ MODE: "repair-everything" });

    await expect(run()).rejects.toThrow("HSCR_ENV_MODE_INVALID");
  });

  describe("dry run", () => {
    it("builds a dry run for the listed companies and logs the result", async () => {
      env({ MODE: " DRY-RUN ", COMPANY_IDS: "3, 5,3" });
      harness.dryRun.mockResolvedValue({ runId: 9, changedRows: 2 });

      await run();

      expect(harness.dryRun).toHaveBeenCalledWith({ createdBy: "render-startup-env", companyIds: [3, 5] });
      expect(harness.logger.info).toHaveBeenCalledWith(
        "HISTORICAL_SALES_COST_REPAIR_DRY_RUN_RESULT",
        expect.objectContaining({ runId: 9, changedRows: 2 })
      );
    });

    it("covers every company when none are listed, and rejects bad company ids", async () => {
      env({ MODE: "dry-run", COMPANY_IDS: "  " });
      harness.dryRun.mockResolvedValue({});
      await run();
      expect(harness.dryRun).toHaveBeenCalledWith({ createdBy: "render-startup-env", companyIds: undefined });

      env({ COMPANY_IDS: "3,x" });
      await expect(run()).rejects.toThrow("HSCR_ENV_COMPANY_IDS_INVALID");
      env({ COMPANY_IDS: "0" });
      await expect(run()).rejects.toThrow("HSCR_ENV_COMPANY_IDS_INVALID");
    });

    it("keeps the deploy healthy when a partial apply is active, but surfaces other failures", async () => {
      env({ MODE: "dry-run" });
      harness.dryRun.mockRejectedValueOnce(new Error("HSCR_DRY_RUN_REFUSED_ACTIVE_PARTIAL_APPLY:4"));
      await expect(run()).resolves.toBeUndefined();
      expect(harness.logger.error).toHaveBeenCalledWith(
        "HISTORICAL_SALES_COST_REPAIR_DRY_RUN_REFUSED",
        expect.objectContaining({ code: "HSCR_DRY_RUN_REFUSED_ACTIVE_PARTIAL_APPLY:4" })
      );

      harness.dryRun.mockRejectedValueOnce(new Error("connection lost"));
      await expect(run()).rejects.toThrow("connection lost");
    });
  });

  describe("apply", () => {
    it.each([
      [{ RUN_ID: "abc", AUDIT_HASH: HASH }, "HSCR_ENV_RUN_ID_INVALID"],
      [{ RUN_ID: "0", AUDIT_HASH: HASH }, "HSCR_ENV_RUN_ID_INVALID"],
      [{ RUN_ID: "7", AUDIT_HASH: "abc" }, "HSCR_ENV_AUDIT_HASH_INVALID"],
    ])("validates %j before reading the run", async (values, code) => {
      env({ MODE: "apply", ...values });

      await expect(run()).rejects.toThrow(code);
      expect(harness.getRun).not.toHaveBeenCalled();
    });

    it("refuses a missing run or one whose audit hash differs", async () => {
      env({ MODE: "apply", RUN_ID: "7", AUDIT_HASH: HASH.toUpperCase() });
      harness.getRun.mockResolvedValueOnce(null);
      await expect(run()).rejects.toThrow("HSCR_RUN_NOT_FOUND:7");

      harness.getRun.mockResolvedValueOnce({ audit_hash: TARGET, status: "ready" });
      await expect(run()).rejects.toThrow("HSCR_ENV_AUDIT_HASH_MISMATCH:7");
      expect(harness.apply).not.toHaveBeenCalled();
    });

    it("skips a run that is already applied", async () => {
      env({ MODE: "apply", RUN_ID: "7", AUDIT_HASH: HASH });
      harness.getRun.mockResolvedValue({ audit_hash: HASH, status: "applied" });

      await run();

      expect(harness.apply).not.toHaveBeenCalled();
      expect(harness.logger.info).toHaveBeenCalledWith(
        "HISTORICAL_SALES_COST_REPAIR_ALREADY_APPLIED",
        expect.anything()
      );
    });

    it("applies a ready run after the cut-over check", async () => {
      env({ MODE: "apply", RUN_ID: "7", AUDIT_HASH: HASH });
      harness.getRun.mockResolvedValue({ audit_hash: HASH, status: "ready" });
      harness.apply.mockResolvedValue({ appliedRows: 4 });

      await run();

      expect(harness.cutover).toHaveBeenCalledWith(7, "historical-sales-cost-apply");
      expect(harness.apply).toHaveBeenCalledWith({ runId: 7, auditHash: HASH, appliedBy: "render-startup-env" });
    });

    it("does not apply once the inventory cut-over refuses it", async () => {
      env({ MODE: "apply", RUN_ID: "7", AUDIT_HASH: HASH });
      harness.getRun.mockResolvedValue({ audit_hash: HASH, status: "ready" });
      harness.cutover.mockRejectedValue(new Error("PERPETUAL_INVENTORY_ACTIVE"));

      await expect(run()).rejects.toThrow("PERPETUAL_INVENTORY_ACTIVE");
      expect(harness.apply).not.toHaveBeenCalled();
    });
  });

  describe("partial apply and rollback", () => {
    it.each(["partial-apply-proven-rows-only", "partial-apply-rollback"])(
      "%s validates the run id and audit hash",
      async (mode) => {
        env({ MODE: mode, RUN_ID: "-1", AUDIT_HASH: HASH });
        await expect(run()).rejects.toThrow("HSCR_ENV_RUN_ID_INVALID");
        env({ RUN_ID: "7", AUDIT_HASH: "z".repeat(64) });
        await expect(run()).rejects.toThrow("HSCR_ENV_AUDIT_HASH_INVALID");
      }
    );

    it("rolls a partial apply back with the operator's confirmation and verifies it", async () => {
      env({ MODE: "partial-apply-rollback", RUN_ID: "7", AUDIT_HASH: HASH, ROLLBACK_CONFIRMATION: " ROLLBACK-7 " });
      harness.rollback.mockResolvedValue({ rolledBackRows: 3 });

      await run();

      expect(harness.cutover).toHaveBeenCalledWith(7, "historical-sales-cost-rollback");
      expect(harness.rollback).toHaveBeenCalledWith({
        runId: 7,
        auditHash: HASH,
        confirmation: "ROLLBACK-7",
        rolledBackBy: "render-startup-env",
      });
      expect(harness.verify).toHaveBeenCalledWith(7);
      expect(harness.logger.info).toHaveBeenCalledWith(
        "HISTORICAL_SALES_COST_REPAIR_PARTIAL_ROLLBACK_RESULT",
        expect.objectContaining({ rolledBackRows: 3, verificationOk: true, rowsAtOriginal: 3 })
      );
    });

    it("needs a valid target hash before previewing a partial apply", async () => {
      env({ MODE: "partial-apply-proven-rows-only", RUN_ID: "7", AUDIT_HASH: HASH, TARGET_HASH: "short" });

      await expect(run()).rejects.toThrow("HSCR_ENV_TARGET_HASH_INVALID");
      expect(harness.preview).not.toHaveBeenCalled();
    });

    it("previews, checks the cut-over, applies the proven rows and verifies them", async () => {
      env({
        MODE: "partial-apply-proven-rows-only",
        RUN_ID: "7",
        AUDIT_HASH: HASH,
        TARGET_HASH: TARGET,
        PARTIAL_CONFIRMATION: "PARTIAL-7",
      });
      harness.preview.mockResolvedValue({
        targetRows: 3,
        targetHash: TARGET,
        liveTargetDrift: { count: 0 },
        reconciliation: { target: "ok" },
      });
      harness.partial.mockResolvedValue({ runId: 7, partialApplyId: 2, appliedRows: 3, alreadyApplied: false });

      await run();

      expect(harness.cutover).toHaveBeenCalledWith(7, "historical-sales-cost-partial-apply");
      expect(harness.partial).toHaveBeenCalledWith({
        runId: 7,
        auditHash: HASH,
        targetHash: TARGET,
        mode: "proven-rows-only",
        confirmation: "PARTIAL-7",
        appliedBy: "render-startup-env",
      });
      expect(harness.logger.info).toHaveBeenCalledWith(
        "HISTORICAL_SALES_COST_REPAIR_PARTIAL_APPLY_RESULT",
        expect.objectContaining({ appliedRows: 3, partialApplyId: 2, verificationOk: true })
      );
    });
  });
});
