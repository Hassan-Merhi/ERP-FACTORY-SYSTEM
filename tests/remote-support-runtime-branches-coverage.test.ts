/**
 * Remote support runtime: boot flags derived from the environment (hard
 * disable, production opt-outs, fast feed opt-out), flag normalisation,
 * metric counters and the frame / viewer / command latency bookkeeping,
 * including every refusal of bad timestamps and the sample caps.
 *
 * The module reads its environment once at import, so each boot scenario
 * re-imports a fresh copy with the environment stubbed and then restored.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Runtime = typeof import("../server/services/remoteSupportRuntime");

async function boot(env: Record<string, string | undefined>): Promise<Runtime> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value as string);
  return import("../server/services/remoteSupportRuntime");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("remote support boot flags", () => {
  it("a hard disable turns everything off and keeps it off", async () => {
    const runtime = await boot({ DISABLE_SCREEN_FEED: "true", NODE_ENV: "production" });
    const snapshot = runtime.getRemoteSupportRuntimeSnapshot();
    expect(snapshot.hardDisabled).toBe(true);
    expect(snapshot.flags).toEqual({
      screenFeedEnabled: false,
      fastScreenFeed: false,
      remoteControl: false,
      keyboardControl: false,
      sensitiveActionProtection: true,
    });
    const updated = runtime.updateRemoteSupportFlags({ screenFeedEnabled: true, remoteControl: true }, "dev");
    expect(updated.flags.screenFeedEnabled).toBe(false);
    expect(updated.flags.remoteControl).toBe(false);
  });

  it("production enables remote and keyboard control unless opted out", async () => {
    const on = await boot({ DISABLE_SCREEN_FEED: "false", NODE_ENV: "production" });
    expect(on.getRemoteSupportRuntimeSnapshot().flags).toMatchObject({
      screenFeedEnabled: true,
      fastScreenFeed: true,
      remoteControl: true,
      keyboardControl: true,
    });

    const keyboardOff = await boot({
      DISABLE_SCREEN_FEED: "false",
      NODE_ENV: "production",
      REMOTE_SUPPORT_KEYBOARD_CONTROL: " FALSE ",
    });
    expect(keyboardOff.getRemoteSupportRuntimeSnapshot().flags).toMatchObject({
      remoteControl: true,
      keyboardControl: false,
    });

    const controlOff = await boot({
      DISABLE_SCREEN_FEED: "false",
      NODE_ENV: "production",
      REMOTE_SUPPORT_REMOTE_CONTROL: "false",
      REMOTE_SUPPORT_FAST_SCREEN_FEED: "False",
    });
    expect(controlOff.getRemoteSupportRuntimeSnapshot().flags).toMatchObject({
      fastScreenFeed: false,
      remoteControl: false,
      keyboardControl: false,
    });
  });

  it("outside production remote control stays off at boot", async () => {
    const runtime = await boot({ DISABLE_SCREEN_FEED: "false", NODE_ENV: "test" });
    expect(runtime.isRemoteSupportEnabled("remoteControl")).toBe(false);
    expect(runtime.isRemoteSupportEnabled("screenFeedEnabled")).toBe(true);
  });
});

describe("remote support flag updates", () => {
  it("filters unknown keys and non-boolean values and normalises dependants", async () => {
    const runtime = await boot({ DISABLE_SCREEN_FEED: "false", NODE_ENV: "test" });
    const before = runtime.getRemoteSupportRuntimeSnapshot().revision;
    const next = runtime.updateRemoteSupportFlags(
      { keyboardControl: true, remoteControl: "yes", bogus: true } as never,
      ""
    );
    expect(next.revision).toBe(before + 1);
    expect(next.updatedBy).toBe("unknown");
    expect(next.flags.keyboardControl).toBe(false);

    const control = runtime.updateRemoteSupportFlags(
      { remoteControl: true, keyboardControl: true, sensitiveActionProtection: false },
      "dev"
    );
    expect(control.flags).toMatchObject({
      remoteControl: true,
      keyboardControl: true,
      sensitiveActionProtection: true,
    });
    expect(control.updatedBy).toBe("dev");

    const noFeed = runtime.updateRemoteSupportFlags({ screenFeedEnabled: false }, "dev");
    expect(noFeed.flags).toMatchObject({ fastScreenFeed: false, remoteControl: false, keyboardControl: false });

    const unprotected = runtime.updateRemoteSupportFlags(
      { screenFeedEnabled: true, sensitiveActionProtection: false },
      "dev"
    );
    expect(unprotected.flags.sensitiveActionProtection).toBe(false);
  });

  it("emergency disable and boot restore record the actor", async () => {
    const runtime = await boot({ DISABLE_SCREEN_FEED: "false", NODE_ENV: "test" });
    const off = runtime.emergencyDisableRemoteSupport("");
    expect(off.updatedBy).toBe("unknown");
    expect(off.flags.screenFeedEnabled).toBe(false);
    const restored = runtime.restoreRemoteSupportBootDefaults("");
    expect(restored.updatedBy).toBe("unknown");
    expect(restored.flags.screenFeedEnabled).toBe(true);
    expect(runtime.restoreRemoteSupportBootDefaults("ops").updatedBy).toBe("ops");
    expect(runtime.emergencyDisableRemoteSupport("ops").updatedBy).toBe("ops");
  });
});

describe("remote support metrics", () => {
  it("counts every metric and guards byte counts", async () => {
    const runtime = await boot({ DISABLE_SCREEN_FEED: "false", NODE_ENV: "test" });
    runtime.resetRemoteSupportMetrics();
    for (const metric of [
      "watcherStatusPoll",
      "viewerPoll",
      "liveStatusConnected",
      "liveViewerConnected",
      "frameRejected",
    ] as const) {
      runtime.recordRemoteSupportMetric(metric);
    }
    runtime.recordRemoteSupportMetric("framePushed", 3.7);
    runtime.recordRemoteSupportMetric("framePushed", -1);
    runtime.recordRemoteSupportMetric("framePushed");
    runtime.recordRemoteSupportMetric("frameAccepted", 1000.9);
    runtime.recordRemoteSupportMetric("frameAccepted", Number.NaN);
    runtime.recordRemoteSupportMetric("frameAccepted");
    const metrics = runtime.getRemoteSupportRuntimeSnapshot().metrics;
    expect(metrics).toMatchObject({
      watcherStatusPolls: 1,
      viewerPolls: 1,
      liveStatusConnections: 1,
      liveViewerConnections: 1,
      framesRejected: 1,
      framesPushed: 5,
      framesAccepted: 3,
      totalFrameBytes: 1000,
      averageFrameBytes: 333,
      lastFrameBytes: 0,
      clickSuccessRate: null,
    });
    expect(metrics.lastFrameAcceptedAt).not.toBeNull();
    expect(metrics.lastViewerPollAt).not.toBeNull();
    const reset = runtime.resetRemoteSupportMetrics().metrics;
    expect(reset).toMatchObject({
      framesAccepted: 0,
      averageFrameBytes: 0,
      lastFrameAcceptedAt: null,
      lastViewerPollAt: null,
    });
    expect(reset.latency.clientToServerMs).toEqual({
      count: 0,
      averageMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      lastMs: null,
    });
  });

  it("records frame, viewer and interval latencies and ignores bad input", async () => {
    const runtime = await boot({ DISABLE_SCREEN_FEED: "false", NODE_ENV: "test" });
    runtime.resetRemoteSupportMetrics();
    runtime.recordRemoteSupportFrameReceived({ feedKey: "", capturedAt: 1000, serverReceivedAt: 1010 });
    runtime.recordRemoteSupportFrameReceived({ feedKey: "f", capturedAt: -5, serverReceivedAt: 1010 });
    runtime.recordRemoteSupportFrameReceived({ feedKey: "f", capturedAt: 1000, serverReceivedAt: Number.NaN });
    runtime.recordRemoteSupportFrameReceived({
      feedKey: "f",
      capturedAt: 1000,
      serverReceivedAt: 1010,
      captureDurationMs: 4,
    });
    runtime.recordRemoteSupportFrameReceived({
      feedKey: "f",
      capturedAt: 1100,
      serverReceivedAt: 1130,
      captureDurationMs: null,
    });
    runtime.recordRemoteSupportFrameReceived({ feedKey: "f", capturedAt: 1050, serverReceivedAt: 1060 });
    // A latency beyond five minutes or negative is not a sample.
    runtime.recordRemoteSupportFrameReceived({
      feedKey: "g",
      capturedAt: 1000,
      serverReceivedAt: 1000 + 6 * 60 * 1000,
    });
    runtime.recordRemoteSupportFrameReceived({ feedKey: "h", capturedAt: 2000, serverReceivedAt: 1500 });
    // Without serverReceivedAt the current time is used: only that sample is out of range.
    runtime.recordRemoteSupportFrameReceived({ feedKey: "now", capturedAt: Date.now() - 5 });

    runtime.recordRemoteSupportViewerRendered({ feedKey: "", capturedAt: 1000, viewerRenderedAt: 1020 });
    runtime.recordRemoteSupportViewerRendered({ feedKey: "f", capturedAt: 0, viewerRenderedAt: 1020 });
    runtime.recordRemoteSupportViewerRendered({ feedKey: "f", capturedAt: 1000, viewerRenderedAt: 1020 });
    runtime.recordRemoteSupportViewerRendered({ feedKey: "f", capturedAt: 1000, viewerRenderedAt: 1030 });

    const latency = runtime.getRemoteSupportRuntimeSnapshot().metrics.latency;
    expect(latency.clientToServerMs.count).toBe(4);
    expect(latency.captureDurationMs).toMatchObject({ count: 1, lastMs: 4 });
    expect(latency.frameIntervalMs).toMatchObject({ count: 1, lastMs: 100 });
    expect(latency.serverToViewerMs).toMatchObject({ count: 1, lastMs: 10 });
    expect(latency.clientToViewerMs).toMatchObject({ count: 2, p50Ms: 20, maxMs: 30, averageMs: 25 });
  });

  it("tracks command sent, result and visible-frame latency", async () => {
    const runtime = await boot({ DISABLE_SCREEN_FEED: "false", NODE_ENV: "test" });
    runtime.resetRemoteSupportMetrics();
    const t = runtime.recordRemoteSupportCommandTelemetry;
    t({ event: "sent", commandId: " ", feedKey: "f", sentAt: 100 });
    t({ event: "sent", commandId: "c0", feedKey: "", sentAt: 100 });
    t({ event: "sent", commandId: "c0", feedKey: "f", sentAt: "x" as never });
    t({ event: "sent", commandId: "c1", feedKey: "f", commandType: "click", sentAt: 100 });
    t({ event: "sent", commandId: "c1", feedKey: "f", commandType: "click", sentAt: 101 });
    t({ event: "result", commandId: "c1", feedKey: "f", executedAt: 150, status: "executed" });
    t({ event: "result", commandId: "c1", feedKey: "f", executedAt: 160, status: "executed" });
    // A result for a command never seen as sent counts as sent; a failure is dropped.
    t({
      event: "result",
      commandId: "c2",
      feedKey: "f",
      commandType: "click",
      sentAt: 200,
      executedAt: 210,
      status: "failed",
    });
    t({ event: "result", commandId: "c3", feedKey: "f", sentAt: 300, executedAt: 320, status: "executed" });
    t({ event: "result", commandId: "c4", feedKey: "f", executedAt: 320, status: "executed" });
    t({ event: "result", commandId: "c5", feedKey: "f", sentAt: 300 });
    t({ event: "sent", commandId: "k1", feedKey: "other", sentAt: 100 });

    let metrics = runtime.getRemoteSupportRuntimeSnapshot().metrics;
    expect(metrics).toMatchObject({
      commandsSent: 4,
      commandsExecuted: 2,
      clickCommandsSent: 2,
      clickCommandsExecuted: 1,
      clickSuccessRate: 0.5,
    });
    expect(metrics.latency.commandSentToExecutedMs.count).toBe(4);

    // A frame captured before execution cannot show the result.
    runtime.recordRemoteSupportViewerRendered({ feedKey: "f", capturedAt: 155, viewerRenderedAt: 400 });
    metrics = runtime.getRemoteSupportRuntimeSnapshot().metrics;
    expect(metrics.latency.commandExecutedToVisibleFrameMs.count).toBe(0);
    runtime.recordRemoteSupportViewerRendered({ feedKey: "f", capturedAt: 330, viewerRenderedAt: 420 });
    metrics = runtime.getRemoteSupportRuntimeSnapshot().metrics;
    expect(metrics.latency.commandExecutedToVisibleFrameMs).toMatchObject({ count: 2 });
    expect(metrics.latency.commandSentToVisibleFrameMs).toMatchObject({ count: 2, maxMs: 319 });
    // Both executed commands were closed, so a later frame adds nothing.
    runtime.recordRemoteSupportViewerRendered({ feedKey: "f", capturedAt: 500, viewerRenderedAt: 600 });
    expect(runtime.getRemoteSupportRuntimeSnapshot().metrics.latency.commandExecutedToVisibleFrameMs.count).toBe(2);
  });

  it("caps latency samples and timing maps", async () => {
    const runtime = await boot({ DISABLE_SCREEN_FEED: "false", NODE_ENV: "test" });
    runtime.resetRemoteSupportMetrics();
    for (let index = 1; index <= 2100; index += 1) {
      runtime.recordRemoteSupportFrameReceived({
        feedKey: "cap",
        capturedAt: index * 10,
        serverReceivedAt: index * 10 + 1,
      });
      runtime.recordRemoteSupportCommandTelemetry({
        event: "sent",
        commandId: `cmd${index}`,
        feedKey: "cap",
        sentAt: index,
      });
    }
    const metrics = runtime.getRemoteSupportRuntimeSnapshot().metrics;
    expect(metrics.latency.clientToServerMs.count).toBe(512);
    expect(metrics.commandsSent).toBe(2100);
    // The oldest frame timing was trimmed: rendering it records no server-to-viewer sample.
    runtime.recordRemoteSupportViewerRendered({ feedKey: "cap", capturedAt: 10, viewerRenderedAt: 50 });
    expect(runtime.getRemoteSupportRuntimeSnapshot().metrics.latency.serverToViewerMs.count).toBe(0);
    runtime.recordRemoteSupportViewerRendered({ feedKey: "cap", capturedAt: 21000, viewerRenderedAt: 21005 });
    expect(runtime.getRemoteSupportRuntimeSnapshot().metrics.latency.serverToViewerMs.count).toBe(1);
  });
});
