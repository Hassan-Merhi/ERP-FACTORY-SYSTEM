import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  allowedRoles: [] as string[][],
  fetchActiveContainers: vi.fn(),
  loadCompanyNames: vi.fn(),
}));

vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: (...roles: string[]) => {
    harness.allowedRoles.push(roles);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../server/lib/gitHelpers", () => ({
  resolveGitCompanyScope: async () => ({ mode: "single", companyId: 4 }),
  fetchActiveContainers: harness.fetchActiveContainers,
  loadCompanyNames: harness.loadCompanyNames,
  enrichContainers: () => [
    { id: 1, companyId: 4, companyName: "HADI", containerNumber: "A", status: "Sea", shopName: "1" },
    { id: 2, companyId: 4, companyName: "HADI", containerNumber: "B", status: "Sea", shopName: "2" },
  ],
  applyGitFilters: (rows: unknown[]) => rows,
  buildSummary: () => ({ total: 2 }),
}));
vi.mock("../server/routes/git/gitListingProfiles", () => ({
  applyGitTableFilters: (rows: unknown[]) => rows,
  buildGitFacets: () => ({ statuses: ["Sea"] }),
  buildGitTableSummary: () => ({ totalCost: 30 }),
  parseGitPagination: () => ({ page: 1, pageSize: 50 }),
  sortGitRows: (rows: unknown[]) => rows,
  toGitCompactRow: (row: unknown) => row,
}));
vi.mock("../server/routes/git/_helpers", () => ({ buildAgentsForCompany: async () => [] }));

import { resetGitContinuousSnapshotsForTests } from "../server/routes/git/gitContinuousSnapshots";
import { registerGitReportRoutes } from "../server/routes/git/gitReportRoutes";

const previousNodeEnv = process.env.NODE_ENV;
const previousSecret = process.env.CONTINUOUS_CURSOR_SECRET;

describe("GIT continuous listing route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.handlers.clear();
    harness.allowedRoles.length = 0;
    resetGitContinuousSnapshotsForTests();
    process.env.NODE_ENV = "test";
    process.env.CONTINUOUS_CURSOR_SECRET = "git-route-wave-two-secret-1234";
    harness.fetchActiveContainers.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    harness.loadCompanyNames.mockResolvedValue({ 4: "HADI" });
    registerGitReportRoutes({
      get: (path: string, ...callbacks: Array<(...args: unknown[]) => unknown>) => {
        harness.handlers.set(path, callbacks.at(-1)!);
      },
    } as never);
  });

  afterEach(() => {
    resetGitContinuousSnapshotsForTests();
    process.env.NODE_ENV = previousNodeEnv;
    if (previousSecret === undefined) delete process.env.CONTINUOUS_CURSOR_SECRET;
    else process.env.CONTINUOUS_CURSOR_SECRET = previousSecret;
  });

  it("permits ERP Tester on read-only GIT reporting routes", () => {
    expect(harness.allowedRoles).toHaveLength(6);
    expect(harness.allowedRoles.every((roles) => roles.includes("ERP Tester"))).toBe(true);
    expect(harness.handlers.has("/api/git/containers")).toBe(true);
    expect(harness.handlers.has("/api/git/agent-duty-summary")).toBe(true);
  });

  it("does the full fetch/enrich pipeline once and slices later chunks from the snapshot", async () => {
    const firstReq = {
      user: { id: "user-7", role: "Admin" },
      session: { currentRole: "Admin", currentCompanyId: 4 },
      query: { continuous: "1", limit: "1", profile: "compact" },
      path: "/api/git/containers",
    };
    const firstRes = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    firstRes.status.mockReturnValue(firstRes);

    await harness.handlers.get("/api/git/containers")!(firstReq, firstRes);

    const firstPayload = firstRes.json.mock.calls[0][0];
    expect(firstPayload).toMatchObject({
      mode: "single",
      companyId: 4,
      companyName: "HADI",
      total: 2,
      limit: 1,
      hasMore: true,
      containers: [{ id: 1, companyId: 4, companyName: "HADI", containerNumber: "A", status: "Sea", shopName: "1" }],
    });
    expect(firstPayload.nextCursor).toEqual(expect.any(String));
    expect(harness.fetchActiveContainers).toHaveBeenCalledTimes(1);
    expect(harness.loadCompanyNames).toHaveBeenCalledTimes(1);

    const secondReq = {
      ...firstReq,
      query: { ...firstReq.query, cursor: firstPayload.nextCursor },
    };
    const secondRes = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    secondRes.status.mockReturnValue(secondRes);

    await harness.handlers.get("/api/git/containers")!(secondReq, secondRes);

    expect(secondRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "single",
        companyId: 4,
        total: 2,
        hasMore: false,
        nextCursor: null,
        containers: [{ id: 2, companyId: 4, companyName: "HADI", containerNumber: "B", status: "Sea", shopName: "2" }],
      })
    );
    expect(harness.fetchActiveContainers).toHaveBeenCalledTimes(1);
    expect(harness.loadCompanyNames).toHaveBeenCalledTimes(1);
  });
});
