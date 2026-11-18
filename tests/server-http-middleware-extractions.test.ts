/**
 * Contract tests for the HTTP middleware extracted from server/index.ts
 * (capacitorCors, httpConventions, csrfProtection, errorHandler). Each test
 * builds a minimal express app so the middleware is exercised in isolation —
 * no database is involved.
 */
import { describe, expect, it } from "vitest";
import express from "express";
import session from "express-session";
import request from "supertest";
import { capacitorCors } from "../server/middleware/capacitorCors";
import { buildVersionHeader, apiNoCache } from "../server/middleware/httpConventions";
import { registerCsrfProtection } from "../server/security/csrfProtection";
import { registerErrorHandler } from "../server/middleware/errorHandler";
import { registerMissingApiJsonHandler } from "../server/startup/staticServing";

describe("capacitorCors", () => {
  const buildApp = () => {
    const app = express();
    app.use(capacitorCors);
    app.get("/api/ping", (_req, res) => res.json({ ok: true }));
    return app;
  };

  it("echoes CORS headers for Capacitor WebView origins and answers preflights", async () => {
    const res = await request(buildApp())
      .options("/api/ping")
      .set("Origin", "capacitor://localhost")
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("capacitor://localhost");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
  });

  it.each(["capacitor://localhost", "ionic://localhost", "https://localhost", "http://localhost"])(
    "allows every header a preflight from %s asks for",
    async (origin) => {
      const asked = "content-type,x-client-date,x-csrf-token,x-request-id,x-idempotency-key";
      const res = await request(buildApp())
        .options("/api/ping")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", asked);

      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-headers"]).toBe(asked);
      expect(res.headers["vary"]).toBe("Origin, Access-Control-Request-Headers");
    }
  );

  it("falls back to the standard header list when a preflight names none", async () => {
    const res = await request(buildApp())
      .options("/api/ping")
      .set("Origin", "https://localhost")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-headers"]).toBe(
      "Content-Type,Authorization,X-CSRF-Token,X-Client-Date,X-Requested-With"
    );
  });

  it("answers a simple request from a native origin with credentials allowed and lets it through", async () => {
    const res = await request(buildApp()).get("/api/ping").set("Origin", "https://localhost");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["access-control-allow-origin"]).toBe("https://localhost");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it.each([
    "https://localhost:8443",
    "https://localhost.evil.example.com",
    "https://evil.example.com",
    "null",
    "file://",
  ])("gives no CORS grant, and does not answer the preflight, for %s", async (origin) => {
    const res = await request(buildApp())
      .options("/api/ping")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "x-request-id");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["access-control-allow-headers"]).toBeUndefined();
    expect(res.status).not.toBe(204);
  });

  it("passes through requests from non-Capacitor origins without CORS headers", async () => {
    const res = await request(buildApp()).get("/api/ping").set("Origin", "https://evil.example.com");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("httpConventions", () => {
  it("stamps every response with the build version", async () => {
    const app = express();
    app.use(buildVersionHeader("build-123"));
    app.get("/api/ping", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/api/ping");
    expect(res.headers["x-build-version"]).toBe("build-123");
  });

  it("disables HTTP caching for API routes only", async () => {
    const app = express();
    app.use(apiNoCache);
    app.get("/api/ping", (_req, res) => res.json({ ok: true }));
    app.get("/index.html", (_req, res) => res.send("html"));

    const api = await request(app).get("/api/ping");
    expect(api.headers["cache-control"]).toContain("no-store");
    expect(api.headers["pragma"]).toBe("no-cache");

    const html = await request(app).get("/index.html");
    expect(html.headers["cache-control"]).toBeUndefined();
  });
});

describe("registerCsrfProtection", () => {
  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use(session({ name: "erp.session", secret: "csrf-test-secret", resave: false, saveUninitialized: false }));
    registerCsrfProtection(app);
    app.post("/api/secure", (_req, res) => res.json({ ok: true }));
    return app;
  };

  it("issues a per-session token via GET /api/csrf-token", async () => {
    const agent = request.agent(buildApp());
    const res = await agent.get("/api/csrf-token");

    expect(res.status).toBe(200);
    expect(res.body.csrfToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("allows state-changing requests carrying the matching token", async () => {
    const agent = request.agent(buildApp());
    const token = (await agent.get("/api/csrf-token")).body.csrfToken;

    const res = await agent.post("/api/secure").set("X-CSRF-Token", token).send({});

    expect(res.status).toBe(200);
  });

  it("blocks state-changing requests with a mismatched token when enforcing", async () => {
    // CI runs the backend suite with CSRF_ENFORCE=0 (warn-only); pin the
    // enforcing mode for this test and restore the environment afterwards.
    const previous = process.env.CSRF_ENFORCE;
    process.env.CSRF_ENFORCE = "1";
    try {
      const agent = request.agent(buildApp());
      await agent.get("/api/csrf-token");

      const res = await agent.post("/api/secure").set("X-CSRF-Token", "wrong-token").send({});

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ message: "CSRF token missing or invalid.", code: "CSRF_TOKEN_MISMATCH" });
    } finally {
      if (previous === undefined) delete process.env.CSRF_ENFORCE;
      else process.env.CSRF_ENFORCE = previous;
    }
  });

  it("lets mismatched tokens through when CSRF_ENFORCE=0 (warn-only)", async () => {
    const previous = process.env.CSRF_ENFORCE;
    process.env.CSRF_ENFORCE = "0";
    try {
      const agent = request.agent(buildApp());
      await agent.get("/api/csrf-token");

      const res = await agent.post("/api/secure").set("X-CSRF-Token", "wrong-token").send({});

      expect(res.status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.CSRF_ENFORCE;
      else process.env.CSRF_ENFORCE = previous;
    }
  });

  it("does not gate requests when no token exists in the session yet", async () => {
    // First-touch POST before the session holds a token — allowed by design.
    const res = await request.agent(buildApp()).post("/api/secure").send({});

    expect(res.status).toBe(200);
  });
});

describe("registerErrorHandler", () => {
  const buildApp = () => {
    const app = express();
    app.get("/api/bad-request", () => {
      const err = new Error("Validation failed") as Error & { status?: number };
      err.status = 400;
      throw err;
    });
    app.get("/api/pool-timeout", () => {
      const err = new Error("pool down") as Error & { cause?: { message?: string } };
      err.cause = { message: "timeout exceeded when trying to connect" };
      throw err;
    });
    registerErrorHandler(app);
    return app;
  };

  it("returns the thrown status and message", async () => {
    const res = await request(buildApp()).get("/api/bad-request");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Validation failed" });
  });

  it("maps database pool timeouts to a 503 with a retry message", async () => {
    const res = await request(buildApp()).get("/api/pool-timeout");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ message: "Service temporarily unavailable — please retry." });
  });
});

describe("production API fallback", () => {
  it("returns JSON 404 for unknown API requests without intercepting registered routes", async () => {
    const app = express();
    app.get("/api/known", (_req, res) => res.json({ ok: true }));
    registerMissingApiJsonHandler(app);
    app.get("/factory/payroll-hub", (_req, res) => res.send("<html>App</html>"));

    const known = await request(app).get("/api/known");
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ ok: true });

    const missing = await request(app).get("/api/factory/workers/not-a-route");
    expect(missing.status).toBe(404);
    expect(missing.headers["content-type"]).toMatch(/application\/json/);
    expect(missing.body).toEqual({
      code: "API_ROUTE_NOT_FOUND",
      message: "API endpoint not found",
    });

    const page = await request(app).get("/factory/payroll-hub");
    expect(page.status).toBe(200);
    expect(page.text).toContain("App");
  });
});
