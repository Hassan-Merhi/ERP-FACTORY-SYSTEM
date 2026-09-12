import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["API_RATE_LIMIT_MAX", "API_RATE_LIMIT_ANON_MAX", "API_RATE_LIMIT_WINDOW_MS"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

async function loadLimiter(env: Record<string, string>) {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  return import("../server/middleware/apiRateLimit");
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

function fakeSession(userId: string | undefined) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (userId !== undefined) {
      (req as unknown as { session: { userId: string } }).session = { userId };
    }
    next();
  };
}

function buildApp(apiRateLimit: (req: Request, res: Response, next: NextFunction) => void, userId?: string) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(fakeSession(userId));
  app.use(apiRateLimit);
  app.get("/api/ping", (_req, res) => res.status(200).json({ ok: true }));
  app.options("/api/ping", (_req, res) => res.sendStatus(204));
  app.get("/api/health/ready", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/api/build-info", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/api/csrf-token", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/other", (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe("global api rate limit", () => {
  it("allows anonymous requests under budget and 429s past it", async () => {
    const { apiRateLimit } = await loadLimiter({
      API_RATE_LIMIT_MAX: "600",
      API_RATE_LIMIT_ANON_MAX: "3",
      API_RATE_LIMIT_WINDOW_MS: "60000",
    });
    const app = buildApp(apiRateLimit);
    const agent = request(app);

    await agent.get("/api/ping").set("X-Forwarded-For", "203.0.113.7").expect(200);
    await agent.get("/api/ping").set("X-Forwarded-For", "203.0.113.7").expect(200);
    await agent.get("/api/ping").set("X-Forwarded-For", "203.0.113.7").expect(200);

    const limited = await agent.get("/api/ping").set("X-Forwarded-For", "203.0.113.7").expect(429);
    expect(limited.body).toMatchObject({
      code: "API_RATE_LIMITED",
      message: "Too many requests. Please slow down and try again shortly.",
    });
    expect(limited.headers["ratelimit-limit"]).toBe("3");

    // A different anonymous IP has its own budget.
    await agent.get("/api/ping").set("X-Forwarded-For", "203.0.113.8").expect(200);
  });

  it("buckets signed-in callers per user instead of per IP", async () => {
    const { apiRateLimit } = await loadLimiter({
      API_RATE_LIMIT_MAX: "2",
      API_RATE_LIMIT_ANON_MAX: "100",
      API_RATE_LIMIT_WINDOW_MS: "60000",
    });

    // Two users behind the same NAT address.
    const appA = buildApp(apiRateLimit, "user-a");
    const appB = buildApp(apiRateLimit, "user-b");

    await request(appA).get("/api/ping").set("X-Forwarded-For", "198.51.100.9").expect(200);
    await request(appA).get("/api/ping").set("X-Forwarded-For", "198.51.100.9").expect(200);
    await request(appA).get("/api/ping").set("X-Forwarded-For", "198.51.100.9").expect(429);

    await request(appB).get("/api/ping").set("X-Forwarded-For", "198.51.100.9").expect(200);
  });

  it("never limits health probes, bootstrap endpoints, preflights, or non-API traffic", async () => {
    const { apiRateLimit } = await loadLimiter({
      API_RATE_LIMIT_MAX: "100",
      API_RATE_LIMIT_ANON_MAX: "1",
      API_RATE_LIMIT_WINDOW_MS: "60000",
    });
    const app = buildApp(apiRateLimit);
    const agent = request(app);
    const ip = { "X-Forwarded-For": "192.0.2.21" } as Record<string, string>;

    await agent.get("/api/ping").set(ip).expect(200);
    await agent.get("/api/ping").set(ip).expect(429);

    await agent.get("/api/health/ready").set(ip).expect(200);
    await agent.get("/api/health/ready").set(ip).expect(200);
    await agent.get("/api/build-info").set(ip).expect(200);
    await agent.get("/api/csrf-token").set(ip).expect(200);
    await agent.options("/api/ping").set(ip).expect(204);
    await agent.get("/other").set(ip).expect(200);
    await agent.get("/other").set(ip).expect(200);
  });
});
