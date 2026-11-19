import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getRemoteSupportRuntimeSnapshot,
  recordRemoteSupportCommandTelemetry,
  recordRemoteSupportFrameReceived,
  recordRemoteSupportViewerRendered,
  resetRemoteSupportMetrics,
} from "../server/services/remoteSupportRuntime";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("remote support Phase 15 presence and audit hygiene", () => {
  it("keeps stale/activity pruning off presence request paths", () => {
    const routes = source("server/routes/userPresenceRoutes.ts");
    const maintenance = source("server/services/presenceMaintenance.ts");

    expect(routes).toContain("installPresenceMaintenance();");
    expect(routes).not.toContain("lt(userPresence.lastSeen");
    expect(routes).not.toContain("DELETE FROM user_activity_log");
    expect(maintenance).toContain("DELETE FROM user_presence WHERE last_seen <");
    expect(maintenance).toContain("row_number() OVER");
    expect(maintenance).toContain("ranked.row_num > ${ACTIVITY_PER_USER_LIMIT}");
  });

  it("scopes presence invalidations and uses the frame tenant gate for history", () => {
    const routes = source("server/routes/userPresenceRoutes.ts");

    expect(routes).toContain('broadcast({ type: "invalidate", topics: ["presence"] }, { companyId });');
    expect(routes).toContain("assertScreenFeedTenantAccess({");
    expect(routes).toContain('new Set(["Admin", "Owner", "Manager", "Developer"])');
    expect(routes).not.toContain('if (role !== "Developer")');
  });

  it("installs bounded retention for permanent remote-support audit rows", () => {
    const audit = source("server/services/remoteSupportAuditService.ts");
    const retention = source("server/services/remoteSupportAuditRetention.ts");

    expect(audit).toContain("installRemoteSupportAuditRetention();");
    expect(retention).toContain("REMOTE_SUPPORT_AUDIT_RETENTION_DAYS");
    expect(retention).toContain("REMOTE_SUPPORT_AUDIT_MAX_ROWS");
    expect(retention).toContain("table_name = 'remote_support_sessions'");
    expect(retention).toContain("action LIKE 'remote_support_%'");
  });
});

describe("remote support Phase 16 latency measurement", () => {
  beforeEach(() => {
    resetRemoteSupportMetrics();
  });

  it("measures capture, frame interval and producer/server/viewer latency", () => {
    const feedKey = "target\u0000tab-a";
    recordRemoteSupportFrameReceived({ feedKey, capturedAt: 1_000, serverReceivedAt: 1_100, captureDurationMs: 35 });
    recordRemoteSupportViewerRendered({ feedKey, capturedAt: 1_000, viewerRenderedAt: 1_180 });
    recordRemoteSupportFrameReceived({ feedKey, capturedAt: 2_000, serverReceivedAt: 2_080, captureDurationMs: 40 });
    recordRemoteSupportViewerRendered({ feedKey, capturedAt: 2_000, viewerRenderedAt: 2_160 });

    const latency = getRemoteSupportRuntimeSnapshot().metrics.latency;
    expect(latency.captureDurationMs.count).toBe(2);
    expect(latency.captureDurationMs.p95Ms).toBe(40);
    expect(latency.frameIntervalMs.p95Ms).toBe(1_000);
    expect(latency.clientToServerMs.p95Ms).toBe(100);
    expect(latency.serverToViewerMs.p95Ms).toBe(80);
    expect(latency.clientToViewerMs.p95Ms).toBe(180);
  });

  it("correlates click sent, executed and first post-execution rendered frame", () => {
    const feedKey = "target\u0000tab-a";
    recordRemoteSupportCommandTelemetry({
      event: "sent",
      commandId: "cmd-1",
      feedKey,
      commandType: "click",
      sentAt: 10_000,
    });
    recordRemoteSupportCommandTelemetry({
      event: "result",
      commandId: "cmd-1",
      feedKey,
      commandType: "click",
      sentAt: 10_000,
      executedAt: 10_090,
      status: "executed",
    });
    recordRemoteSupportViewerRendered({ feedKey, capturedAt: 10_120, viewerRenderedAt: 10_180 });

    const metrics = getRemoteSupportRuntimeSnapshot().metrics;
    expect(metrics.commandsSent).toBe(1);
    expect(metrics.commandsExecuted).toBe(1);
    expect(metrics.clickCommandsSent).toBe(1);
    expect(metrics.clickCommandsExecuted).toBe(1);
    expect(metrics.clickSuccessRate).toBe(1);
    expect(metrics.latency.commandSentToExecutedMs.p95Ms).toBe(90);
    expect(metrics.latency.commandExecutedToVisibleFrameMs.p95Ms).toBe(90);
    expect(metrics.latency.commandSentToVisibleFrameMs.p95Ms).toBe(180);
  });

  it("keeps telemetry bounded on the authenticated binary/control paths", () => {
    const binaryServer = source("server/services/screenFeedWebSocketTransport.ts");
    const binaryClient = source("client/src/lib/screen-feed-binary-transport.ts");
    const controlClient = source("client/src/lib/remote-control-session-transport.ts");
    const wsServer = source("server/wsServer.ts");

    expect(binaryServer).toContain("recordRemoteSupportFrameReceived");
    expect(binaryServer).toContain("screen-feed:viewer-rendered");
    expect(binaryClient).toContain("viewerRenderedAt: Date.now()");
    expect(controlClient).toContain('type: "remote-support:telemetry"');
    expect(wsServer).toContain("recordRemoteSupportCommandTelemetry");
    expect(wsServer).toContain("isRemoteControlControllerRole(context.role)");
  });
});
