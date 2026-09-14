import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Wave 2 live-page policy", () => {
  it("uses the shared websocket for Chat instead of page-level polling or a second socket", () => {
    const chat = source("client/src/pages/Chat.tsx");
    expect(chat).toContain("subscribeRealtimeChatEvents");
    expect(chat).not.toContain("useWsInvalidation();");
    expect(chat).not.toContain("new WebSocket(");
    expect(chat).not.toContain("refetchInterval:");
    expect(chat).not.toContain("fetch(`/api/chat/typing/${selectedUserId}`");
  });

  it("throttles typing to one start and one stop signal per typing burst", () => {
    const chat = source("client/src/pages/Chat.tsx");
    expect(chat).toContain("if (!typingActiveRef.current)");
    expect(chat).toContain("typingActiveRef.current = true");
    expect(chat).toContain("setTimeout(stopLocalTyping, 3000)");
  });

  it("keeps presence heartbeats silent in generic invalidation middleware", () => {
    const applicationRoutes = source("server/routes/applicationRoutes.ts");
    const realtimePolicy = source("shared/realtimeInvalidation.ts");
    const presenceRoutes = source("server/routes/userPresenceRoutes.ts");

    // The write-signal policy lives next to the classifier; the generic
    // middleware must keep delegating the write/no-write decision to it.
    expect(applicationRoutes.includes("shouldEmitWriteInvalidation(req.method, url)")).toBe(true);
    expect(realtimePolicy).toContain('path === "/api/user-presence"');
    expect(realtimePolicy).toContain('path.startsWith("/api/user-presence/")');
    expect(presenceRoutes).toContain('if (type === "route_change")');
    expect(presenceRoutes).toContain("broadcastPresenceChange();");
    expect(presenceRoutes).not.toContain('if (type === "heartbeat")');
  });

  it("keeps presence heartbeat and settings fallbacks bounded", () => {
    const presence = source("client/src/hooks/use-presence.ts");
    const activeUsers = source("client/src/pages/settings/ActiveUsersSection.tsx");
    const watchUser = source("client/src/pages/settings/WatchUserDialog.tsx");

    expect(presence).toContain("const HEARTBEAT_INTERVAL = 90000");
    expect(activeUsers).toContain("refetchInterval: 30000");
    expect(watchUser).toContain("refetchInterval: 30000");
  });

  it("keeps scan fallbacks slow/visible instead of aggressive polling", () => {
    const dailyScan = source("client/src/pages/factory/DailyScan.tsx");
    const groundScan = source("client/src/pages/factory/GroundScan.tsx");

    expect(dailyScan).toContain("visibleTabInterval(90_000)");
    expect(dailyScan).toContain("refetchIntervalInBackground: false");
    expect(groundScan).toContain("visibleTabInterval(30_000)");
    expect(groundScan).toContain("refetchIntervalInBackground: false");
    expect(dailyScan).not.toMatch(/visibleTabInterval\((?:1_?000|2_?000|3_?000|4_?000|5_?000)\)/);
    expect(groundScan).not.toMatch(/visibleTabInterval\((?:1_?000|2_?000|3_?000|4_?000|5_?000)\)/);
  });
});
