import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ACTIVE_CAPTURE_DELAY_MS,
  ACTIVE_CAPTURE_MIN_GAP_MS,
  FAILED_CAPTURE_BACKOFF_MS,
  IDLE_REFRESH_MS,
} from "../client/src/hooks/screen-feed-capture-policy";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

const runtimeSource = read("server/services/remoteSupportRuntime.ts");
const transportSource = read("server/routes/screenFeedTransportHardening.ts");
const routesSource = read("server/routes/applicationRoutes.ts");
const viewerSource = read("client/src/pages/settings/WatchUserDialog.tsx");
const captureSource = read("client/src/hooks/use-screen-feed.ts");
const controllerContextSource = read("client/src/components/RemoteControllerSessionContext.tsx");

describe("Phase 5 faster remote viewing contracts", () => {
  it("keeps fast mode enabled by default with an explicit deployment opt-out", () => {
    expect(runtimeSource).toContain("fastScreenFeed: fastScreenFeedBootEnabled()");
    expect(runtimeSource).toContain("REMOTE_SUPPORT_FAST_SCREEN_FEED");
  });

  it("supports conditional polling without retransmitting unchanged frames", () => {
    expect(transportSource).toContain('res.setHeader("ETag", etag)');
    expect(transportSource).toContain('req.headers["if-none-match"]');
    expect(transportSource).toContain("res.status(304).end()");
    expect(transportSource).toContain('res.setHeader("X-Screen-Feed-Transport"');
  });

  it("adds reconnect jitter, payload limits, and producer backpressure", () => {
    expect(transportSource).toContain("MAX_RECONNECT_JITTER_MS");
    expect(transportSource).toContain("FAST_MAX_FRAME_SIZE = 900_000");
    expect(transportSource).toContain("LEGACY_MAX_FRAME_SIZE = 1_500_000");
    expect(transportSource).toContain("res.status(413)");
    expect(transportSource).toContain('res.setHeader("Retry-After"');
    expect(transportSource).toContain("res.status(429)");
  });

  it("registers hardening before the existing screen-feed routes", () => {
    const hardeningIndex = routesSource.indexOf("registerScreenFeedTransportHardening(app)");
    const screenFeedIndex = routesSource.indexOf("registerScreenFeedRoutes(app)");
    expect(hardeningIndex).toBeGreaterThan(-1);
    expect(screenFeedIndex).toBeGreaterThan(hardeningIndex);
  });

  it("cleans up watched-user switches while retaining polling fallback", () => {
    expect(viewerSource).toContain("eventSource?.close()");
    expect(viewerSource).toContain("[streamGeneration, userId]");
    expect(viewerSource).toContain("refetchInterval: liveConnected ? false : visibleTabInterval(3_000)");
    expect(viewerSource).toContain("setLiveFrame(null)");
    expect(viewerSource).toContain("setLiveCursor(null)");
  });

  it("keeps full-frame capture serialized, dirty-driven, and hidden-tab aware", () => {
    expect(captureSource).toContain("busyRef.current");
    expect(captureSource).toContain("new MutationObserver");
    expect(captureSource).toContain('document.visibilityState !== "visible"');
    expect(captureSource).toContain("markDirty(");
    expect(captureSource).toContain("startMutationObserver");
    expect(captureSource).toContain("stopMutationObserver");
  });

  it("treats CSS class and inline-style changes as capture-worthy visual updates", () => {
    expect(captureSource).toContain("CAPTURE_MUTATION_ATTRIBUTE_FILTER");
    expect(captureSource).toMatch(/CAPTURE_MUTATION_ATTRIBUTE_FILTER[\s\S]*"class"/);
    expect(captureSource).toMatch(/CAPTURE_MUTATION_ATTRIBUTE_FILTER[\s\S]*"style"/);
  });

  it("debounces and scopes remote-viewer target discovery to portal roots", () => {
    expect(controllerContextSource).toContain("WATCH_TARGET_REFRESH_DEBOUNCE_MS");
    expect(controllerContextSource).toContain("scheduleTargetRefresh");
    expect(controllerContextSource).toContain("PORTAL_SCOPE_SELECTOR");
    expect(controllerContextSource).toContain("scopedObservers");
    expect(controllerContextSource).not.toContain(
      "observer.observe(document.body, { childList: true, subtree: true })"
    );
  });

  it("uses a low-impact capture cadence instead of the old 150ms loop", () => {
    // The 850 ms floor this once required was layered on the HTTP/base64 upload
    // limiter. Phase 13-14 removed that limiter and the per-frame base64 encode,
    // and replaced the hard floor with an adaptive duty ceiling, so the reviewed
    // gap is 220 ms. It still has to stay clear of the old free-running loop.
    expect(ACTIVE_CAPTURE_MIN_GAP_MS).toBeGreaterThanOrEqual(200);
    expect(ACTIVE_CAPTURE_DELAY_MS).toBe(ACTIVE_CAPTURE_MIN_GAP_MS);
    expect(IDLE_REFRESH_MS).toBeGreaterThanOrEqual(60_000);
    expect(FAILED_CAPTURE_BACKOFF_MS).toBeGreaterThanOrEqual(3_000);
  });
});
