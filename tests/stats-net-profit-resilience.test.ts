import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeResponse = EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
  once: (event: string, listener: (...args: any[]) => void) => FakeResponse;
};

function response(): FakeResponse {
  const res = new EventEmitter() as FakeResponse;
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function request(companyId?: number, toDate = "2026-01-01") {
  return {
    session: { currentCompanyId: companyId },
    query: { toDate },
  } as any;
}

async function registeredMiddleware() {
  const { registerStatsNetProfitResilience } = await import("../server/routes/stats/statsNetProfitResilience");
  let handler: any;
  const app = {
    get: (_path: string, callback: any) => {
      handler = callback;
    },
  } as any;
  registerStatsNetProfitResilience(app);
  return handler as (req: any, res: FakeResponse, next: (error?: unknown) => void) => Promise<void>;
}

describe("net-profit resilience middleware", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through when no company is selected and serves a live payload", async () => {
    const middleware = await registeredMiddleware();
    const noCompany = response();
    const next = vi.fn();
    await middleware(request(), noCompany, next);
    expect(next).toHaveBeenCalledWith();

    const res = response();
    const downstream = vi.fn(() => {
      res.status(200).json({ totalIncome: 100, netPosition: 40, source: "live" });
    });
    await middleware(request(101), res, downstream);
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ totalIncome: 100, netPosition: 40 });
    expect(res.headers["X-Financial-Data-Status"]).toBe("live");
    expect(res.headers["Cache-Control"]).toContain("stale-if-error");
  });

  it("returns fresh cached data without invoking the calculation handler", async () => {
    const middleware = await registeredMiddleware();
    const first = response();
    await middleware(request(102), first, () => {
      first.status(200).json({ totalIncome: 12, netPosition: 8 });
    });

    const cached = response();
    const next = vi.fn();
    await middleware(request(102), cached, next);
    expect(next).not.toHaveBeenCalled();
    expect(cached.body).toEqual({ totalIncome: 12, netPosition: 8 });
    expect(cached.headers["X-Financial-Data-Status"]).toBe("cached");
  });

  it("serves stale last-known-good figures when the downstream calculation fails", async () => {
    const middleware = await registeredMiddleware();
    const first = response();
    await middleware(request(103, "2026-02-02"), first, () => {
      first.status(200).json({ totalIncome: 50, netPosition: 11 });
    });
    vi.advanceTimersByTime(31_000);

    const failed = response();
    await middleware(request(103, "2026-02-02"), failed, () => {
      failed.status(500).json({ message: "database unavailable" });
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.body).toMatchObject({
      totalIncome: 50,
      netPosition: 11,
      _dashboardData: { status: "stale", staleAgeSeconds: 31 },
    });
    expect(failed.headers["X-Financial-Data-Status"]).toBe("stale");
  });

  it("deduplicates concurrent calculations and gives followers the resulting payload", async () => {
    const middleware = await registeredMiddleware();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const leaderRes = response();
    let calls = 0;
    const leader = middleware(request(104, "2026-02-03"), leaderRes, async () => {
      calls += 1;
      await gate;
      leaderRes.status(200).json({ totalIncome: 9, netPosition: 3 });
    });

    await Promise.resolve();
    const followerRes = response();
    const follower = middleware(request(104, "2026-02-03"), followerRes, vi.fn());
    await Promise.resolve();
    release();
    await Promise.all([leader, follower]);

    expect(calls).toBe(1);
    expect(followerRes.body).toEqual({ totalIncome: 9, netPosition: 3 });
    expect(followerRes.headers["X-Financial-Data-Status"]).toBe("cached");
  });

  it("does not fabricate a payload when the first calculation fails without a cache", async () => {
    const middleware = await registeredMiddleware();
    const res = response();
    const next = vi.fn();
    await middleware(request(105), res, () => {
      res.status(500).json({ message: "failed" });
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: "failed" });
    expect(next).not.toHaveBeenCalled();
  });
});
