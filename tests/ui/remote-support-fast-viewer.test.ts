import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const viewer = readFileSync("client/src/pages/settings/RemoteSupportWatchDialog.tsx", "utf8");
const activeUsers = readFileSync("client/src/pages/settings/ActiveUsersSection.tsx", "utf8");
const transport = readFileSync("client/src/lib/screen-feed-binary-transport.ts", "utf8");

describe("remote support fast viewer", () => {
  it("uses the watcher-readable capability endpoint and unified viewer", () => {
    expect(viewer).toContain('queryKey: ["/api/screen-feed/capabilities"]');
    expect(viewer).not.toContain('apiRequest("GET", "/api/screen-feed/admin/runtime")');
    expect(viewer).toContain("runtime?.flags?.screenFeedEnabled === false");
    expect(viewer).toContain("<ScreenFeedDialog");
    expect(activeUsers).toContain("<RemoteSupportWatchDialog");
  });

  it("keeps binary frames primary but retains a conditional HTTP polling fallback", () => {
    expect(transport).toContain('headers["If-None-Match"] = viewerPollEtag');
    expect(transport).toContain("if (response.status === 304)");
    expect(transport).toContain('viewerPollEtag = response.headers.get("ETag") || null');
    expect(transport).toContain('transport: "http-fallback"');
    expect(transport).toContain("emitFrame({");
  });

  it("starts fallback polling while the socket is unavailable and cleans it up completely", () => {
    expect(transport).toContain("scheduleViewerPollingFallback(0)");
    expect(transport).toContain("viewerPollAbort?.abort()");
    expect(transport).toContain("window.clearTimeout(viewerPollTimer)");
    expect(transport).toContain("stopViewerPollingFallback(true)");
    expect(transport).toContain("current?.close(1000, \"Screen feed idle\")");
  });
});
