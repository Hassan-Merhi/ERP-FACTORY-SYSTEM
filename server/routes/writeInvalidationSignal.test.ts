import { EventEmitter } from "node:events";

import type { Express, NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyRealtimeWrite } from "../../shared/realtimeInvalidation";

const broadcast = vi.hoisted(() => vi.fn());
vi.mock("../wsServer", () => ({ broadcast }));

import { registerWriteInvalidationSignal } from "./writeInvalidationSignal";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

function mountedMiddleware(): Middleware {
  const use = vi.fn();
  registerWriteInvalidationSignal({ use } as unknown as Express);
  expect(use).toHaveBeenCalledTimes(1);
  return use.mock.calls[0][0] as Middleware;
}

function respond(
  middleware: Middleware,
  {
    method,
    url,
    statusCode = 200,
    body = {},
    headers = {},
  }: {
    method: string;
    url: string;
    statusCode?: number;
    body?: unknown;
    headers?: Record<string, string>;
  }
) {
  const req = { method, originalUrl: url, url, body, headers, session: { currentCompanyId: 42 } } as unknown as Request;
  const res = Object.assign(new EventEmitter(), { statusCode }) as unknown as Response;
  const next = vi.fn();
  middleware(req, res, next);
  expect(next).toHaveBeenCalledOnce();
  (res as unknown as EventEmitter).emit("finish");
}

describe("registerWriteInvalidationSignal", () => {
  beforeEach(() => broadcast.mockReset());

  it("broadcasts the classified invalidation, scoped to the active company, after a successful write", () => {
    const middleware = mountedMiddleware();
    respond(middleware, { method: "POST", url: "/api/stock-transfers", body: { fromLocationId: 3 } });

    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(
      { type: "invalidate", ...classifyRealtimeWrite("/api/stock-transfers", { fromLocationId: 3 }) },
      { companyId: 42, excludeRealtimeClientId: null }
    );
  });

  it("stays silent for reads, failed writes and presence heartbeats", () => {
    const middleware = mountedMiddleware();
    respond(middleware, { method: "GET", url: "/api/stock-transfers" });
    respond(middleware, { method: "POST", url: "/api/stock-transfers", statusCode: 422 });
    respond(middleware, { method: "POST", url: "/api/user-presence" });

    expect(broadcast).not.toHaveBeenCalled();
  });

  it("skips the echo only to the tab that scanned a loading bale", () => {
    const middleware = mountedMiddleware();
    const headers = { "x-realtime-client-id": "  tab-1  " };
    respond(middleware, { method: "POST", url: "/api/factory/customer-orders/9/bales", headers });
    respond(middleware, { method: "POST", url: "/api/stock-transfers", headers });

    expect(broadcast.mock.calls.map(([, options]) => options.excludeRealtimeClientId)).toEqual(["tab-1", null]);
  });
});
