import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "../lib/logger";
import { CSP_REPORT_PATH, registerCspReportRoute, resetCspReportThrottleForTests } from "./contentSecurityPolicy";

describe("contentSecurityPolicy report collection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCspReportThrottleForTests();
  });

  function buildApp() {
    const app = express();
    registerCspReportRoute(app);
    return app;
  }

  it("collects reports at the path the enforced policy names in report-uri", () => {
    expect(CSP_REPORT_PATH).toBe("/api/csp-report");
  });

  it("accepts browser violation reports and always answers 204", async () => {
    const response = await request(buildApp())
      .post("/api/csp-report")
      .set("Content-Type", "application/csp-report")
      .send(
        JSON.stringify({
          "csp-report": { "effective-directive": "script-src", "blocked-uri": "https://evil.example/x.js" },
        })
      )
      .expect(204);

    expect(response.text).toBe("");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "[CSP] enforced policy violation reported: script-src blocked https://evil.example/x.js",
      {
        event: "security.csp_report",
        directive: "script-src",
        blocked: "https://evil.example/x.js",
      }
    );
  });

  it("throttles repeat violations so a flood cannot spam the logs", async () => {
    const app = buildApp();
    const payload = { "csp-report": { "effective-directive": "img-src", "blocked-uri": "https://x.example/a.png" } };
    await request(app).post("/api/csp-report").send(payload).expect(204);
    await request(app).post("/api/csp-report").send(payload).expect(204);
    await request(app).post("/api/csp-report").send(payload).expect(204);

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("strips query strings from logged URIs", async () => {
    await request(buildApp())
      .post("/api/csp-report")
      .send({
        "csp-report": { "violated-directive": "connect-src", "blocked-uri": "https://x.example/p?token=secret" },
      })
      .expect(204);

    expect(logger.warn).toHaveBeenCalledWith(
      "[CSP] enforced policy violation reported: connect-src blocked https://x.example/p",
      {
        event: "security.csp_report",
        directive: "connect-src",
        blocked: "https://x.example/p",
      }
    );
  });
});
