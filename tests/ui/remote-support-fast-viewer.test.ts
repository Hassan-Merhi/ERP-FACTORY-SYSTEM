import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const viewer = readFileSync("client/src/pages/settings/RemoteSupportWatchDialog.tsx", "utf8");
const activeUsers = readFileSync("client/src/pages/settings/ActiveUsersSection.tsx", "utf8");

describe("remote support fast viewer", () => {
  it("probes capabilities with a watcher-readable endpoint in the unified viewer", () => {
    // The capability probe must be readable by every authorized watcher, not
    // just Developers, or non-Developer watchers cannot open the viewer at all.
    expect(viewer).toContain('queryKey: ["/api/screen-feed/capabilities"]');
    expect(viewer).not.toContain('apiRequest("GET", "/api/screen-feed/admin/runtime")');
    expect(viewer).toContain("<ScreenFeedDialog");
    expect(activeUsers).toContain("<RemoteSupportWatchDialog");
  });

  it("renders frames from the binary transport rather than an HTTP frame poll", () => {
    // Phase 13-16 moved the viewer onto the tab-scoped binary websocket. The
    // ETag/304 polling loop it replaced must not come back alongside it.
    expect(viewer).toContain("subscribeScreenFeedBinaryFrames");
    expect(viewer).toContain('type: "image/jpeg"');
    expect(viewer).toContain("setFrame(next)");
    expect(viewer).toContain("reportScreenFeedFrameRendered");
    expect(viewer).not.toContain('"If-None-Match"');
    expect(viewer).not.toContain("new EventSource");
  });

  it("tracks transport status and releases every per-frame resource on teardown", () => {
    expect(viewer).toContain("subscribeScreenFeedTransportStatus");
    expect(viewer).toContain('message.type === "screen-feed-transport-ready"');
    expect(viewer).toContain('message.type === "screen-feed-transport-disconnected"');
    // Each frame allocates an object URL, so the previous one and the last one
    // both have to be revoked or the viewer leaks a blob per frame.
    expect(viewer).toContain("unsubscribeFrames()");
    expect(viewer).toContain("unsubscribeStatus()");
    expect(viewer).toContain("URL.revokeObjectURL(objectUrlRef.current)");
    expect(viewer).toContain("objectUrlRef.current = null");
  });
});
