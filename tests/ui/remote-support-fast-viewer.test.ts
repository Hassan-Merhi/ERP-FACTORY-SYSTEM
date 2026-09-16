import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const viewer = readFileSync("client/src/pages/settings/RemoteSupportWatchDialog.tsx", "utf8");
const activeUsers = readFileSync("client/src/pages/settings/ActiveUsersSection.tsx", "utf8");

describe("remote support fast viewer", () => {
  it("uses the runtime flag to choose live transport in the unified viewer", () => {
    // The capability probe must be readable by every authorized watcher, not
    // just Developers, or non-Developer watchers are pinned to polling mode.
    expect(viewer).toContain('queryKey: ["/api/screen-feed/capabilities"]');
    expect(viewer).not.toContain('apiRequest("GET", "/api/screen-feed/admin/runtime")');
    expect(viewer).toContain("runtime?.flags?.fastScreenFeed === true");
    expect(viewer).toContain("<ScreenFeedDialog");
    expect(activeUsers).toContain("<RemoteSupportWatchDialog");
  });

  it("retains ETags and treats 304 as a successful unchanged frame", () => {
    expect(viewer).toContain('"If-None-Match": state.etag');
    expect(viewer).toContain("if (response.status === 304) return state");
    expect(viewer).toContain('etag: response.headers.get("ETag")');
    expect(viewer).toContain("setFrame(next.frame)");
  });

  it("uses SSE with abortable polling fallback and complete watched-user cleanup", () => {
    expect(viewer).toContain("new EventSource");
    expect(viewer).toContain("pollAbortRef.current?.abort()");
    expect(viewer).toContain("eventSource?.close()");
    expect(viewer).toContain("window.clearInterval(intervalId)");
    expect(viewer).toContain("stateRef.current = { etag: null, frame: null, failure: null }");
  });
});
