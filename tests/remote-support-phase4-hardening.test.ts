import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  sanitizeScreenFeedCapture,
  sanitizeScreenFeedFailure,
  sanitizeScreenFeedFailureReason,
} from "../server/services/screenFeedService";

const read = (path: string) => readFileSync(path, "utf8");

const controlRoutes = read("server/routes/remoteControlSessionRoutes.ts");
const keyboardRoutes = read("server/routes/remoteKeyboardControlRoutes.ts");
const controllerContext = read("client/src/components/RemoteControllerSessionContext.tsx");
const screenRoutes = read("server/routes/screenFeedRoutes.ts");
const captureHook = read("client/src/hooks/use-screen-feed.ts");
const captureEngine = read("client/src/hooks/screen-feed-capture-engine.ts");
const viewer = read("client/src/pages/settings/RemoteSupportWatchDialog.tsx");
const manifest = JSON.parse(read("config/route-manifest.json")) as { routes: string[] };

function manifestHas(method: string, path: string): boolean {
  return manifest.routes.some((route) => route.startsWith(`${method} ${path} [`));
}

describe("remote support phase 4 hardening", () => {
  it("sanitizes production capture failure reasons before storage or logs", () => {
    const sanitized = sanitizeScreenFeedFailureReason(
      "SecurityError at https://erp.example.com/private?token=abc user@example.com\nsecret\tvalue"
    );

    expect(sanitized).toContain("[url]");
    expect(sanitized).toContain("[email]");
    expect(sanitized).not.toContain("token=abc");
    expect(sanitized).not.toContain("user@example.com");
    expect(sanitized).not.toMatch(/[\r\n\t]/);
    expect(sanitized?.length ?? 0).toBeLessThanOrEqual(180);
  });

  it("accepts bounded diagnostic payloads and rejects malformed ones", () => {
    expect(
      sanitizeScreenFeedFailure({
        stage: "encode",
        reason: "SecurityError while encoding https://example.com/private",
        durationMs: 824,
      })
    ).toEqual({ stage: "encode", reason: "SecurityError while encoding [url]", durationMs: 824 });

    expect(
      sanitizeScreenFeedFailure({
        stage: "upload",
        reason: "Screen frame upload rejected (413).",
        durationMs: 1200,
      })
    ).toEqual({ stage: "upload", reason: "Screen frame upload rejected (413).", durationMs: 1200 });

    expect(sanitizeScreenFeedFailure({ stage: "not-real", reason: "x", durationMs: 1 })).toBeNull();
    expect(sanitizeScreenFeedFailure({ stage: "pipeline", reason: "", durationMs: 1 })).toBeNull();
    expect(sanitizeScreenFeedFailure({ stage: "pipeline", reason: "x", durationMs: 31_000 })).toEqual({
      stage: "pipeline",
      reason: "x",
    });
  });

  it("preserves only sanitized fallback reasons in frame metadata", () => {
    const capture = sanitizeScreenFeedCapture({
      width: 1280,
      height: 720,
      source: "fallback",
      quality: 0.5,
      encodedBytes: 80_000,
      durationMs: 900,
      failureReason: "Canvas failed on https://erp.example.com/a user@example.com",
    });

    expect(capture).toEqual({
      width: 1280,
      height: 720,
      source: "fallback",
      quality: 0.5,
      encodedBytes: 80_000,
      durationMs: 900,
      failureReason: "Canvas failed on [url] [email]",
    });
  });

  it("returns exact encode and upload failure stages from the capture engine", () => {
    expect(captureEngine).toContain('failureStage: "encode"');
    expect(captureEngine).toContain('failureStage: "upload"');
    expect(captureEngine).toContain("Screen-feed WebSocket transport is not ready.");
    expect(captureHook).toContain('result.failureStage ?? "pipeline"');
    expect(captureHook).toContain("result.failureReason ??");
  });

  it("beacons failures over the existing control channel, not a route of their own", () => {
    expect(captureHook).toContain('type: "screen-feed:failure"');
    expect(captureHook).toContain("failure: { stage, reason:");
    expect(screenRoutes).toContain("recordCaptureFailure(userId, tabId, req.body?.failure)");
    expect(screenRoutes).not.toContain('app.post("/api/screen-feed/capture-failure"');
  });

  it("streams and polls sanitized capture failures to the viewer", () => {
    expect(screenRoutes).toContain('writeEvent(res, "capture-failure"');
    expect(screenRoutes).toContain("captureFailure: serializeFailure(failure)");
    expect(viewer).toContain('message.type === "screen-feed:failure"');
    expect(viewer).toContain('t("Screen capture issue")');
  });

  it("returns keyboard authorization in controller-active instead of a second GET", () => {
    expect(controlRoutes).toContain("getRemoteKeyboardAuthorization(session.id, controllerUserId)");
    expect(controlRoutes).toContain("keyboardAuthorization: serializeKeyboardAuthorization(keyboardAuthorization)");
    expect(keyboardRoutes).not.toContain(
      'app.get(\n    "/api/screen-feed/control/sessions/:sessionId/keyboard-authorization"'
    );
    expect(controllerContext).not.toContain("KeyboardAuthorizationResponse");
    expect(controllerContext).not.toContain("keyboardPayload");
  });

  it("keeps the route manifest stable after consolidating the new reads and beacons", () => {
    expect(manifestHas("GET", "/api/screen-feed/capabilities")).toBe(true);
    expect(manifestHas("POST", "/api/screen-feed/pointer")).toBe(true);
    expect(manifestHas("POST", "/api/screen-feed/control/sessions/:sessionId/keyboard-authorization")).toBe(true);
    expect(manifestHas("GET", "/api/screen-feed/control/sessions/:sessionId/keyboard-authorization")).toBe(false);
    expect(manifestHas("POST", "/api/screen-feed/capture-failure")).toBe(false);
  });
});
