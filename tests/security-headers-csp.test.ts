import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { securityHeadersMiddleware } from "../server/security/securityHeaders";

function appWithSecurityHeaders(nodeEnv: string) {
  const app = express();
  app.use(securityHeadersMiddleware(nodeEnv));
  app.get("/", (_req, res) => res.status(200).send("ok"));
  return app;
}

function cspDirective(header: string, name: string): string | undefined {
  return header
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive === name || directive.startsWith(`${name} `));
}

describe("security headers CSP", () => {
  it("keeps production JavaScript same-origin and blocks inline handlers", async () => {
    const response = await request(appWithSecurityHeaders("production")).get("/").expect(200);
    const csp = String(response.headers["content-security-policy"] ?? "");

    expect(cspDirective(csp, "default-src")).toBe("default-src 'self'");
    expect(cspDirective(csp, "script-src")).toBe("script-src 'self'");
    expect(cspDirective(csp, "script-src-attr")).toBe("script-src-attr 'none'");
    expect(cspDirective(csp, "object-src")).toBe("object-src 'none'");
    expect(cspDirective(csp, "base-uri")).toBe("base-uri 'self'");
    expect(cspDirective(csp, "frame-ancestors")).toBe("frame-ancestors 'self'");
    expect(cspDirective(csp, "frame-src")).toBe("frame-src 'self' blob:");
    expect(cspDirective(csp, "upgrade-insecure-requests")).toBe("upgrade-insecure-requests");
    expect(cspDirective(csp, "media-src")).toBe("media-src 'self' blob: data:");
    expect(cspDirective(csp, "report-uri")).toBe("report-uri /api/csp-report");
    // One policy, enforced: no second report-only copy to drift from it.
    expect(response.headers["content-security-policy-report-only"]).toBeUndefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("limits Vite script relaxations to non-production environments", async () => {
    const response = await request(appWithSecurityHeaders("development")).get("/").expect(200);
    const csp = String(response.headers["content-security-policy"] ?? "");
    const scriptDirective = cspDirective(csp, "script-src") ?? "";

    expect(scriptDirective).toContain("'self'");
    expect(scriptDirective).toContain("'unsafe-inline'");
    expect(scriptDirective).toContain("'unsafe-eval'");
    expect(cspDirective(csp, "script-src-attr")).toBe("script-src-attr 'none'");
    expect(cspDirective(csp, "frame-src")).toBe("frame-src 'self' blob:");
    expect(cspDirective(csp, "upgrade-insecure-requests")).toBeUndefined();
  });
});
