import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../server/lib/logger";
import { getOperationalEventSnapshot, resetOperationalEventsForTests } from "../server/lib/operationalEvents";
import {
  _testOnly_resetPermissionSignals,
  permissionMonitoringConfiguration,
  permissionSignalCounts,
  recordPermissionSignal,
  sanitizeSignalPath,
} from "../server/services/security/permissionMonitor";
import { classifyRefusal } from "../server/middleware/permissionResponseObserver";

describe("permission monitoring signals", () => {
  beforeEach(() => {
    _testOnly_resetPermissionSignals();
    resetOperationalEventsForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it("records route paths only, never query strings or identifiers", () => {
    expect(sanitizeSignalPath("/api/suppliers/123?token=abc&email=a@b.c")).toBe("/api/suppliers/:id");
    expect(sanitizeSignalPath("/api/sessions/0f8fad5b-d9cb-469f-a165-70867728950e")).toBe("/api/sessions/:id");
    expect(sanitizeSignalPath(`/api/${"x".repeat(400)}`)?.length).toBeLessThanOrEqual(161);
    expect(sanitizeSignalPath(undefined)).toBeUndefined();
  });

  it("logs a structured event without sensitive detail keys", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    recordPermissionSignal({
      kind: "cross_company_attempt",
      code: "CROSS_COMPANY_ACCESS_DENIED",
      companyId: 4,
      userId: "u-1",
      role: "Manager",
      method: "POST",
      path: "/api/suppliers?password=hunter2",
      detail: { password: "hunter2", token: "t", sessionId: "s", revision: 3 },
    });
    const [, payload] = warn.mock.calls[0]!;
    const text = JSON.stringify(payload);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("token");
    expect(text).not.toContain("sessionId");
    expect(payload).toMatchObject({
      event: "permission_signal",
      kind: "cross_company_attempt",
      path: "/api/suppliers",
      detail: { revision: 3 },
    });
  });

  it("counts per company and escalates security signals to operational events", () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    recordPermissionSignal({ kind: "permission_denied", code: "VIEW_ONLY_WRITE_DENIED", companyId: 1 });
    recordPermissionSignal({ kind: "cross_company_attempt", code: "CROSS_COMPANY_ACCESS_DENIED", companyId: 1 });
    recordPermissionSignal({ kind: "permission_service_error", code: "PERMISSION_V2_UNAVAILABLE", companyId: 2 });
    expect(permissionSignalCounts(1).counts).toMatchObject({
      permission_denied: 1,
      cross_company_attempt: 1,
      permission_service_error: 0,
    });
    expect(permissionSignalCounts(2).counts.permission_service_error).toBe(1);
    expect(permissionSignalCounts(null).counts.permission_denied).toBe(1);
    const events = getOperationalEventSnapshot();
    expect(events.counts.integrity).toBe(1);
    expect(events.counts.error).toBe(1);
    expect(events.byCode.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["permission_cross_company_attempt", "permission_permission_service_error"])
    );
  });

  it("flags repeated forbidden mutations once per window", () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const attempt = (now: number) =>
      recordPermissionSignal(
        {
          kind: "permission_denied",
          code: "BUSINESS_ACTION_NOT_VERIFIED",
          companyId: 9,
          userId: "u",
          method: "DELETE",
          path: "/api/vouchers/5",
        },
        now
      );
    for (let index = 0; index < 4; index += 1) attempt(1_000 + index);
    expect(permissionSignalCounts(9).counts.repeated_forbidden_mutation).toBe(0);
    attempt(2_000);
    expect(permissionSignalCounts(9).counts.repeated_forbidden_mutation).toBe(1);
    attempt(2_100);
    expect(permissionSignalCounts(9).counts.repeated_forbidden_mutation).toBe(1);
    expect(warn).toHaveBeenCalled();
    // Reads never count as forbidden mutations.
    for (let index = 0; index < 10; index += 1) {
      recordPermissionSignal({
        kind: "permission_denied",
        code: "X",
        companyId: 8,
        userId: "u",
        method: "GET",
        path: "/api/x",
      });
    }
    expect(permissionSignalCounts(8).counts.repeated_forbidden_mutation).toBe(0);
  });

  it("reports alert routing without exposing the destination", () => {
    const configured = permissionMonitoringConfiguration({
      LOG_ALERTS_ENABLED: "true",
      LOG_ALERT_WEBHOOK_URL: "https://hooks.example/secret",
    });
    expect(configured.alertDestinationConfigured).toBe(true);
    expect(JSON.stringify(configured)).not.toContain("hooks.example");
    expect(permissionMonitoringConfiguration({}).alertDestinationConfigured).toBe(false);
  });
});

describe("refused response classification", () => {
  it("separates permission denials, cross-company attempts and unexpected 403s", () => {
    expect(classifyRefusal({ status: 403, code: "VIEW_ONLY_WRITE_DENIED" })).toEqual({
      kind: "permission_denied",
      code: "VIEW_ONLY_WRITE_DENIED",
    });
    expect(classifyRefusal({ status: 403, message: "View Only accounts cannot make changes" })).toEqual({
      kind: "permission_denied",
      code: "LEGACY_FORBIDDEN",
    });
    expect(classifyRefusal({ status: 403, code: "CROSS_COMPANY_ACCESS_DENIED" })?.kind).toBe("cross_company_attempt");
    expect(classifyRefusal({ status: 400, code: "COMPANY_ID_CONFLICT" })?.kind).toBe("cross_company_attempt");
    expect(classifyRefusal({ status: 403, code: "SOMETHING_NEW" })).toEqual({
      kind: "unexpected_forbidden",
      code: "SOMETHING_NEW",
    });
    expect(classifyRefusal({ status: 403 })).toEqual({ kind: "unexpected_forbidden", code: "FORBIDDEN_WITHOUT_CODE" });
    expect(classifyRefusal({ status: 400, code: "VALIDATION_FAILED" })).toBeNull();
    // Recorded at the source, never twice.
    expect(classifyRefusal({ status: 403, code: "PERMISSION_V2_DENIED" })).toBeNull();
    expect(classifyRefusal({ status: 409, code: "LAST_COMPANY_ADMINISTRATOR" })).toBeNull();
  });
});
