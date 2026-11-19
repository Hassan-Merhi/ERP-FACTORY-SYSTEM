import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const events = vi.hoisted(() => ({ recorded: [] as Array<Record<string, unknown>> }));
vi.mock("../server/lib/operationalEvents", () => ({
  recordOperationalEvent: (event: Record<string, unknown>) => events.recorded.push(event),
}));

import { handleClientObservability } from "../server/middleware/clientObservability";

const ENDPOINT = "/api/auth/observability/client-error";
let nextUser = 7000 + Math.floor(Math.random() * 1e6);

type FakeRes = Response & { statusCode: number; payload: unknown };

function fakeReq(overrides: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  session?: Record<string, unknown> | undefined;
  user?: { id: unknown };
  body?: unknown;
  ip?: string;
}): Request {
  return {
    method: overrides.method ?? "POST",
    path: overrides.path ?? ENDPOINT,
    headers: overrides.headers ?? {},
    session: "session" in overrides ? overrides.session : { userId: ++nextUser },
    user: overrides.user,
    body: overrides.body,
    ip: overrides.ip,
    socket: { remoteAddress: undefined },
  } as unknown as Request;
}

function fakeRes(): FakeRes {
  const res = { statusCode: 0, payload: undefined } as FakeRes;
  res.status = ((code: number) => {
    res.statusCode = code;
    return res;
  }) as never;
  res.json = ((body: unknown) => {
    res.payload = body;
    return res;
  }) as never;
  return res;
}

function send(req: Request) {
  const res = fakeRes();
  const handled = handleClientObservability(req, res, "req-1");
  return { handled, res };
}

const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
const savedEnv = { url: process.env.OBSERVABILITY_WEBHOOK_URL, token: process.env.OBSERVABILITY_WEBHOOK_TOKEN };

beforeEach(() => {
  events.recorded = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedEnv.url === undefined) delete process.env.OBSERVABILITY_WEBHOOK_URL;
  else process.env.OBSERVABILITY_WEBHOOK_URL = savedEnv.url;
  if (savedEnv.token === undefined) delete process.env.OBSERVABILITY_WEBHOOK_TOKEN;
  else process.env.OBSERVABILITY_WEBHOOK_TOKEN = savedEnv.token;
});

describe("handleClientObservability", () => {
  it("ignores other methods and paths", () => {
    expect(send(fakeReq({ method: "GET" })).handled).toBe(false);
    expect(send(fakeReq({ path: "/api/other" })).handled).toBe(false);
  });

  it("rejects cross-origin reports and accepts trusted or same-host origins", () => {
    const body = { message: "boom" };
    const foreign = send(fakeReq({ headers: { origin: "https://evil.example", host: "erp.local" }, body }));
    expect(foreign.res.statusCode).toBe(403);
    const noHost = send(fakeReq({ headers: { origin: "https://evil.example" }, body }));
    expect(noHost.res.statusCode).toBe(403);
    const badUrl = send(fakeReq({ headers: { referer: "not a url", host: "erp.local" }, body }));
    expect(badUrl.res.statusCode).toBe(403);
    const app = send(fakeReq({ headers: { origin: "capacitor://localhost" }, body }));
    expect(app.res.statusCode).toBe(202);
    const sameHost = send(fakeReq({ headers: { referer: "https://erp.local/page", host: "erp.local" }, body }));
    expect(sameHost.res.statusCode).toBe(202);
    const sameOrigin = send(fakeReq({ headers: { origin: "https://erp.local", host: "erp.local" }, body }));
    expect(sameOrigin.res.statusCode).toBe(202);
    expect(events.recorded).toHaveLength(3);
  });

  it("requires a positive integer user id from the session or request user", () => {
    expect(send(fakeReq({ session: undefined, body: { message: "x" } })).res.statusCode).toBe(401);
    expect(send(fakeReq({ session: { userId: "abc" }, body: { message: "x" } })).res.statusCode).toBe(401);
    expect(send(fakeReq({ session: { userId: -3 }, body: { message: "x" } })).res.statusCode).toBe(401);
    const viaUser = send(fakeReq({ session: {}, user: { id: ++nextUser }, ip: "10.9.9.9", body: { message: "u" } }));
    expect(viaUser.res.statusCode).toBe(202);
  });

  it("rejects empty or non-string messages without recording", () => {
    for (const body of [undefined, {}, { message: "   " }, { message: 42 }]) {
      const { res } = send(fakeReq({ body }));
      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ message: "A non-empty error message is required." });
    }
    expect(events.recorded).toHaveLength(0);
  });

  it("records a cleaned event with the company and truncates oversized fields", () => {
    const userId = ++nextUser;
    const longMessage = "m".repeat(5_000);
    const { res } = send(
      fakeReq({
        session: { userId, factoryCompanyId: 12 },
        headers: { "user-agent": "jest" },
        body: {
          message: longMessage,
          source: "react",
          route: "/sales/new?draft=1#top",
          stack: "Error: x\n at y",
          componentStack: "in Foo",
          buildVersion: "v1",
          lastRequestId: "abc",
        },
      })
    );
    expect(res.statusCode).toBe(202);
    expect(res.payload).toEqual({ accepted: true, requestId: "req-1" });
    expect(events.recorded[0]).toMatchObject({
      code: "client_application_error",
      path: "/sales/new",
      userId,
      companyId: 12,
    });
    expect((events.recorded[0].message as string).length).toBe(2_000);
  });

  it("drops non-path routes and falls back to the current company or none", () => {
    send(fakeReq({ session: { userId: ++nextUser, currentCompanyId: 4 }, body: { message: "a", route: "http://x" } }));
    expect(events.recorded[0]).toMatchObject({ path: undefined, companyId: 4 });
    send(fakeReq({ body: { message: "b" } }));
    expect(events.recorded[1]).not.toHaveProperty("companyId");
  });

  it("deduplicates repeated reports from the same user", () => {
    const userId = ++nextUser;
    const body = { message: "same", route: "/x", stack: "Error: same\nline2" };
    expect(send(fakeReq({ session: { userId }, body })).res.statusCode).toBe(202);
    const second = send(fakeReq({ session: { userId }, body }));
    expect(second.res.payload).toEqual({ accepted: false, reason: "duplicate" });
    expect(events.recorded).toHaveLength(1);
  });

  it("rate limits a user after twenty reports in a window", () => {
    const userId = ++nextUser;
    for (let i = 0; i < 20; i++) {
      expect(send(fakeReq({ session: { userId }, body: { message: `m${i}` } })).res.statusCode).toBe(202);
    }
    const limited = send(fakeReq({ session: { userId }, body: { message: "over" } }));
    expect(limited.res.payload).toEqual({ accepted: false, reason: "rate_limited" });
    expect(events.recorded).toHaveLength(20);
  });

  it("forwards to the external webhook with a bearer token and survives delivery failures", async () => {
    process.env.OBSERVABILITY_WEBHOOK_URL = "https://hooks.example/obs";
    process.env.OBSERVABILITY_WEBHOOK_TOKEN = "tkn";
    send(fakeReq({ body: { message: "hook" } }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example/obs");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tkn");
    expect(JSON.parse(init.body as string)).toMatchObject({ event: "client_error", message: "hook" });

    delete process.env.OBSERVABILITY_WEBHOOK_TOKEN;
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const { res } = send(fakeReq({ body: { message: "hook2" } }));
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init2] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((init2.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("does not call out when no webhook is configured", async () => {
    delete process.env.OBSERVABILITY_WEBHOOK_URL;
    send(fakeReq({ body: { message: "quiet" } }));
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
