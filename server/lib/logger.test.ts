import { describe, expect, it } from "vitest";
import { __loggerTesting } from "./logger";

describe("shared logger readability", () => {
  it("converts inventory row logs into a sentence", () => {
    expect(
      __loggerTesting.humanizeLegacyMessage(
        "[getLocationInventory] companyId=1 locationId=135 includeZero=false → 820 rows",
        {}
      )
    ).toBe("Inventory loaded for location 135 with 820 items");
  });

  it("converts WhatsApp upload success into a sentence", () => {
    expect(
      __loggerTesting.humanizeLegacyMessage("[WA upload] Green API response", {
        fileName: "Hadi 2 Invoice 2026-08-04.pdf",
        size: 6779,
      })
    ).toBe("WhatsApp uploaded Hadi 2 Invoice 2026-08-04.pdf successfully (6.6 KB)");
  });

  it("converts HTTP request lines into readable outcomes", () => {
    expect(
      __loggerTesting.humanizeLegacyMessage("POST /api/pos/send-invoice-pdf-backend 200", {
        durationMs: 6121,
        slow: true,
        thresholdMs: 5000,
      })
    ).toBe(
      "POST /api/pos/send-invoice-pdf-backend completed with status 200 in 6.12 seconds; warning threshold 5.00 seconds"
    );
  });

  it("summarises bandwidth reporting windows with only the top endpoints", () => {
    expect(
      __loggerTesting.humanizeLegacyMessage("Ranked endpoint performance and bandwidth snapshot", {
        windowMs: 300000,
        totalApiResponseBytes: 24196990,
        apiEndpointCount: 42,
        ranked: [
          {
            method: "GET",
            path: "/api/locations/:id/inventory",
            totalResponseBytes: 6702273,
          },
          {
            method: "GET",
            path: "/api/ledger-accounts",
            totalResponseBytes: 4017216,
          },
        ],
      })
    ).toBe(
      "API responses transferred 23.1 MB across 42 endpoints during the last 5.0 minutes. Top endpoints: GET /api/locations/:id/inventory 6.39 MB; GET /api/ledger-accounts 3.83 MB"
    );
  });

  it("moves routine inventory and lifecycle starts to DEBUG", () => {
    expect(
      __loggerTesting.resolveEffectiveLevel(
        "info",
        "[getLocationInventory] companyId=1 locationId=135 includeZero=false → 820 rows",
        {}
      )
    ).toBe("debug");
    expect(
      __loggerTesting.resolveEffectiveLevel("info", "POS sale update started", {
        module: "pos",
        action: "updateSale",
      })
    ).toBe("debug");
    expect(
      __loggerTesting.resolveEffectiveLevel("info", "POS sale update succeeded", {
        module: "pos",
        action: "updateSale",
      })
    ).toBe("info");
  });

  it("never demotes security events, whatever request-controlled text they carry", () => {
    const message = "[CSP] report-only policy observation: connect-src blocked https://x.example/heartbeat";
    expect(__loggerTesting.resolveEffectiveLevel("info", message, {})).toBe("debug");
    expect(__loggerTesting.resolveEffectiveLevel("info", message, { event: "security.csp_report" })).toBe("info");
  });

  it("moves the legacy duplicate Express slow line to DEBUG", () => {
    expect(
      __loggerTesting.resolveEffectiveLevel(
        "info",
        "12:28:13 PM [express] [SLOW API] POST /api/pos/send-invoice-pdf-backend 200 in 1121ms",
        {}
      )
    ).toBe("debug");
  });

  it("derives stable event names from operational event codes", () => {
    expect(
      __loggerTesting.resolveEvent({
        module: "operational_events",
        action: "event_detected",
        code: "large_http_response",
      })
    ).toBe("operational.large_http_response");
  });
});
