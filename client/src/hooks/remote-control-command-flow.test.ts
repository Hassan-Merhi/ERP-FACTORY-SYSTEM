import { describe, expect, it } from "vitest";
import {
  applyRemoteControlRateLimit,
  clearRemoteControlRateLimit,
  createRemoteControlRateGate,
  decideRemoteControlCommand,
  isRemoteControlRateLimitError,
  isRemoteControlSendBlocked,
  remoteControlSendDelayMs,
} from "./remote-control-command-flow";

describe("remote control command flow", () => {
  describe("rate gate", () => {
    it("starts open", () => {
      const gate = createRemoteControlRateGate();
      expect(isRemoteControlSendBlocked(gate, 1000)).toBe(false);
      expect(remoteControlSendDelayMs(gate, 1000)).toBe(0);
    });

    it("honors the exact server backoff hint", () => {
      const gate = applyRemoteControlRateLimit(createRemoteControlRateGate(), 1000, 420);
      expect(gate.blockedUntil).toBe(1420);
      expect(isRemoteControlSendBlocked(gate, 1419)).toBe(true);
      expect(isRemoteControlSendBlocked(gate, 1420)).toBe(false);
    });

    it("caps an unreasonably long hint", () => {
      const gate = applyRemoteControlRateLimit(createRemoteControlRateGate(), 0, 120_000);
      expect(gate.blockedUntil).toBe(5000);
    });

    it("backs off exponentially when the server sends no hint", () => {
      let gate = applyRemoteControlRateLimit(createRemoteControlRateGate(), 0, null);
      expect(gate.blockedUntil).toBe(250);
      gate = applyRemoteControlRateLimit(gate, 0, null);
      expect(gate.blockedUntil).toBe(500);
      gate = applyRemoteControlRateLimit(gate, 0, null);
      expect(gate.blockedUntil).toBe(1000);
    });

    it("never exceeds the backoff ceiling", () => {
      let gate = createRemoteControlRateGate();
      for (let index = 0; index < 20; index += 1) gate = applyRemoteControlRateLimit(gate, 0, undefined);
      expect(gate.blockedUntil).toBe(5000);
    });

    it("reopens on the next successful send", () => {
      const blocked = applyRemoteControlRateLimit(createRemoteControlRateGate(), 1000, 500);
      const cleared = clearRemoteControlRateLimit(blocked);
      expect(cleared.blockedUntil).toBe(0);
      expect(cleared.consecutiveRefusals).toBe(0);
      expect(isRemoteControlSendBlocked(cleared, 1000)).toBe(false);
    });

    it("keeps an already-open gate identical rather than churning state", () => {
      const gate = createRemoteControlRateGate();
      expect(clearRemoteControlRateLimit(gate)).toBe(gate);
    });
  });

  describe("command decisions", () => {
    it("sends ordinary commands while the gate is open", () => {
      const gate = createRemoteControlRateGate();
      for (const kind of ["pointer-move", "click", "scroll", "keyboard"] as const) {
        expect(decideRemoteControlCommand({ kind, gate, now: 1000 })).toBe("send");
      }
    });

    it("drops continuous samples while the gate is closed", () => {
      const gate = applyRemoteControlRateLimit(createRemoteControlRateGate(), 1000, 500);
      expect(decideRemoteControlCommand({ kind: "pointer-move", gate, now: 1100 })).toBe("supersede");
      expect(decideRemoteControlCommand({ kind: "scroll", gate, now: 1100 })).toBe("supersede");
    });

    it("defers discrete click and keyboard intent instead of discarding it", () => {
      const gate = applyRemoteControlRateLimit(createRemoteControlRateGate(), 1000, 500);
      expect(decideRemoteControlCommand({ kind: "click", gate, now: 1100 })).toBe("defer");
      expect(decideRemoteControlCommand({ kind: "keyboard", gate, now: 1100 })).toBe("defer");
      expect(remoteControlSendDelayMs(gate, 1100)).toBe(400);
    });

    it("supersedes a pointer move once a newer sample exists", () => {
      const gate = createRemoteControlRateGate();
      expect(decideRemoteControlCommand({ kind: "pointer-move", gate, now: 1000, hasNewerPointerSample: true })).toBe(
        "supersede"
      );
      expect(decideRemoteControlCommand({ kind: "click", gate, now: 1000, hasNewerPointerSample: true })).toBe("send");
    });

    it("resumes sending the moment the window reopens", () => {
      const gate = applyRemoteControlRateLimit(createRemoteControlRateGate(), 1000, 500);
      expect(decideRemoteControlCommand({ kind: "pointer-move", gate, now: 1500 })).toBe("send");
    });
  });

  describe("backpressure detection", () => {
    it("recognizes 429 rate limits and fail-closed audit 503s", () => {
      expect(isRemoteControlRateLimitError({ status: 429 })).toBe(true);
      expect(isRemoteControlRateLimitError({ status: 400, code: "COMMAND_RATE_LIMITED" })).toBe(true);
      expect(isRemoteControlRateLimitError({ status: 400, code: "KEYBOARD_RATE_LIMITED" })).toBe(true);
      expect(isRemoteControlRateLimitError({ status: 503 })).toBe(true);
      expect(isRemoteControlRateLimitError({ status: 500, code: "REMOTE_SUPPORT_AUDIT_UNAVAILABLE" })).toBe(true);
    });

    it("does not treat authorization or sensitive-route denial as pacing", () => {
      expect(isRemoteControlRateLimitError({ status: 428, code: "MOUSE_AUTHORIZATION_REQUIRED" })).toBe(false);
      expect(isRemoteControlRateLimitError({ status: 403, code: "SENSITIVE_REMOTE_ACTION_BLOCKED" })).toBe(false);
      expect(isRemoteControlRateLimitError({ status: 500, code: null })).toBe(false);
    });
  });
});
