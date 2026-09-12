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
import {
  helmetContentSecurityPolicyOption,
  registerCspReportRoute,
  resetCspReportThrottleForTests,
  resolveCspMode,
} from "./contentSecurityPolicy";

describe("contentSecurityPolicy", () => {
  describe("resolveCspMode", () => {
    it("is report-only by default in production", () => {
      expect(resolveCspMode({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("report-only");
    });

    it("is off by default outside production", () => {
      expect(resolveCspMode({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe("off");
      expect(resolveCspMode({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe("off");
    });

    it("enforces when CSP_ENFORCE=true in any environment", () => {
      expect(resolveCspMode({ NODE_ENV: "production", CSP_ENFORCE: "true" } as NodeJS.ProcessEnv)).toBe("enforce");
      expect(resolveCspMode({ NODE_ENV: "development", CSP_ENFORCE: "true" } as NodeJS.ProcessEnv)).toBe("enforce");
    });
  });

  describe("helmetContentSecurityPolicyOption", () => {
    it("returns false when the policy is off", () => {
      expect(helmetContentSecurityPolicyOption({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
    });

    it("keeps scripts locked to 'self' with violation reporting wired up", () => {
      const option = helmetContentSecurityPolicyOption({
        NODE_ENV: "production",
        CSP_ENFORCE: "true",
      } as NodeJS.ProcessEnv);
      expect(option).not.toBe(false);
      if (option === false) return;
      const directives = (option as { directives: Record<string, string[]> }).directives;
      expect(directives["script-src"]).toEqual(["'self'"]);
      expect(directives["object-src"]).toEqual(["'none'"]);
      expect(directives["report-uri"]).toEqual(["/api/csp-report"]);
      expect(option).toMatchObject({ reportOnly: false });
    });

    it("uses report-only mode for the production default", () => {
      const option = helmetContentSecurityPolicyOption({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
      expect(option).not.toBe(false);
      expect(option).toMatchObject({ reportOnly: true });
    });
  });

  describe("registerCspReportRoute", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      resetCspReportThrottleForTests();
    });

    function buildApp() {
      const app = express();
      registerCspReportRoute(app);
      return app;
    }

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
      expect(logger.warn).toHaveBeenCalledWith("[CSP] policy violation reported", {
        directive: "script-src",
        blocked: "https://evil.example/x.js",
      });
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

      expect(logger.warn).toHaveBeenCalledWith("[CSP] policy violation reported", {
        directive: "connect-src",
        blocked: "https://x.example/p",
      });
    });
  });
});
