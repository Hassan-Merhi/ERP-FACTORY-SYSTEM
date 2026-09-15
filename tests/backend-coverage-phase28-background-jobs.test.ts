/**
 * Phase 28 — Background jobs and schedulers.
 *
 * These tests pin the scheduler process-safety contract: overlapping ticks do
 * not execute the same work twice, a failed run releases its lock so the next
 * scheduled retry can proceed, and ENABLE_SCHEDULERS=false prevents cron
 * registration even when the scheduler module is called directly.
 */
import cron from "node-cron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "../server/lib/logger";
import { createSchedulerTick } from "../server/services/scheduler/schedulerTickGuard";
import { schedulersEnabled, startScheduler } from "../server/services/scheduler";

const originalEnableSchedulers = process.env.ENABLE_SCHEDULERS;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
});

afterEach(() => {
  if (originalEnableSchedulers === undefined) delete process.env.ENABLE_SCHEDULERS;
  else process.env.ENABLE_SCHEDULERS = originalEnableSchedulers;
  vi.restoreAllMocks();
});

describe("Phase 28 scheduler lifecycle", () => {
  it("allows only one concurrent execution of the same scheduled tick", async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const tick = createSchedulerTick("phase28ConcurrentJob", run);

    const first = tick();
    await Promise.all([tick(), tick(), tick()]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      "cron tick skipped: previous run still in progress",
      expect.objectContaining({ action: "phase28ConcurrentJob" })
    );

    gate.resolve();
    await first;
  });

  it("releases the in-flight lock after failure so the next scheduled retry succeeds", async () => {
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary scheduled provider failure"))
      .mockResolvedValueOnce(undefined);
    const tick = createSchedulerTick("phase28RetryJob", run);

    await expect(tick()).resolves.toBeUndefined();
    await expect(tick()).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      "cron phase28RetryJob failed",
      expect.objectContaining({ action: "phase28RetryJob" })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "cron phase28RetryJob succeeded",
      expect.objectContaining({ action: "phase28RetryJob" })
    );
  });

  it("cleans up the lock after a rejected run even when another tick was skipped", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const run = vi.fn().mockReturnValueOnce(firstGate.promise).mockReturnValueOnce(secondGate.promise);
    const tick = createSchedulerTick("phase28CleanupJob", run);

    const first = tick();
    await tick();
    expect(run).toHaveBeenCalledTimes(1);

    firstGate.reject(new Error("first run failed"));
    await expect(first).resolves.toBeUndefined();

    const retry = tick();
    expect(run).toHaveBeenCalledTimes(2);
    secondGate.resolve();
    await retry;
  });

  it("treats only the explicit string false as scheduler-disabled", () => {
    expect(schedulersEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(schedulersEnabled({ ENABLE_SCHEDULERS: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(schedulersEnabled({ ENABLE_SCHEDULERS: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(schedulersEnabled({ ENABLE_SCHEDULERS: "false" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("registers no cron jobs when ENABLE_SCHEDULERS=false even if startScheduler is called directly", () => {
    process.env.ENABLE_SCHEDULERS = "false";
    const scheduleSpy = vi.spyOn(cron, "schedule");

    startScheduler();

    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("Schedulers disabled; cron registration skipped", {
      module: "scheduler",
      action: "start",
    });
  });
});
