// Phase 4 certification anchor: scheduler lock coverage remains intentional.
/**
 * A scheduled job does not overtake itself.
 *
 * node-cron fires on the clock, not on completion. Scheduled jobs can spend
 * meaningful time on reports, provider calls, and network I/O, while the location
 * report job fires every minute — so a run can outlive its own interval.
 * Overlapping runs re-read the same due work and compete for the same
 * connections while reporting durations that mean nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSchedulerTick } from "../server/services/scheduler/schedulerTickGuard";
import { logger } from "../server/lib/logger";
import { getSchedulerCallbackName } from "../server/lib/schedulerObservability";

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
  vi.restoreAllMocks();
});

describe("scheduler tick guard", () => {
  it("carries a stable observability name into node-cron", () => {
    const tick = createSchedulerTick("probeJob", async () => undefined);
    expect(getSchedulerCallbackName(tick)).toBe("probeJob");
  });

  it("skips a tick that arrives while the previous run is still going", async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const tick = createSchedulerTick("probeJob", run);

    const first = tick();
    await tick();

    // The second tick returned without starting the work.
    expect(run).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "cron tick skipped: previous run still in progress",
      expect.objectContaining({ action: "probeJob" })
    );

    gate.resolve();
    await first;
  });

  it("runs again once the previous run has finished", async () => {
    const first = deferred();
    const second = deferred();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const tick = createSchedulerTick("probeJob", run);

    const firstRun = tick();
    first.resolve();
    await firstRun;

    const secondRun = tick();
    second.resolve();
    await secondRun;

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("releases the guard when a run throws", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("report generation failed")).mockResolvedValueOnce(undefined);
    const tick = createSchedulerTick("probeJob", run);

    // A failed run that left the guard held would silence the job for the
    // lifetime of the process — the failure mode this guard must not introduce.
    await expect(tick()).resolves.toBeUndefined();
    await tick();

    expect(run).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith("cron probeJob failed", expect.objectContaining({ action: "probeJob" }));
  });

  it("absorbs the failure instead of rejecting into cron", async () => {
    const tick = createSchedulerTick("probeJob", async () => {
      throw new Error("boom");
    });

    // cron has nowhere to send a rejection; an unhandled one can take down a
    // process configured to exit on them.
    await expect(tick()).resolves.toBeUndefined();
  });

  it("stays silent on a quiet job's routine success but still reports failures", async () => {
    const tick = createSchedulerTick("quietJob", async () => undefined, { quiet: true });
    await tick();
    expect(logger.info).not.toHaveBeenCalled();

    const failing = createSchedulerTick(
      "quietJob",
      async () => {
        throw new Error("send failed");
      },
      { quiet: true }
    );
    await failing();
    expect(logger.error).toHaveBeenCalledWith("cron quietJob failed", expect.objectContaining({ action: "quietJob" }));
  });
});
