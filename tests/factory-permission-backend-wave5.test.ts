import { beforeEach, describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  authorizeFactoryPageAccess: vi.fn(),
}));

vi.mock("../server/lib/factoryAccessControl", () => ({
  authorizeFactoryPageAccess: accessMocks.authorizeFactoryPageAccess,
  sendFactoryAccessDenied: (res: any, decision: any) =>
    res.status(403).json({ message: decision.message, code: decision.code }),
}));

import {
  enforceFactoryBackendAccess,
  resolveFactoryBackendAccessRequirement,
} from "../server/middleware/factoryBackendAccessBoundary";

function request(path: string, options: Record<string, unknown> = {}) {
  return {
    session: { userId: "wave5-user" },
    method: "GET",
    originalUrl: `/api/factory${path}`,
    path,
    query: {},
    body: {},
    ...options,
  } as any;
}

function response() {
  const state = { status: 200, body: undefined as unknown };
  const res: any = {
    status: vi.fn((status: number) => {
      state.status = status;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      state.body = body;
      return res;
    }),
  };
  return { res, state };
}

const normalState = {
  userId: "wave5-user",
  companyId: 1,
  role: "User",
  privileged: false,
  fullAccess: false,
  hasErpAccess: true,
  hasFactoryAccess: true,
  pageKeys: ["factory/daybook"],
  hiddenTabs: [] as string[],
};

describe("Wave 5 Factory backend access certification", () => {
  beforeEach(() => {
    accessMocks.authorizeFactoryPageAccess.mockReset();
  });

  it("maps sensitive page and tab APIs to canonical owners", () => {
    expect(resolveFactoryBackendAccessRequirement(request("/accounts/12"))).toEqual({
      pageKey: "factory/accounts",
    });
    expect(resolveFactoryBackendAccessRequirement(request("/daybook"))).toEqual({
      pageKey: "factory/daybook",
      tabs: ["hide_tab_daybook_transactions"],
    });
    expect(resolveFactoryBackendAccessRequirement(request("/import/raw-stock"))).toEqual({
      pageKey: "factory/import",
      tabs: ["hide_tab_import_raw_stock"],
    });
    expect(resolveFactoryBackendAccessRequirement(request("/stock-allocation-v5/preview"))).toEqual({
      pageKey: "factory/stock-allocation-v5",
    });
    expect(resolveFactoryBackendAccessRequirement(request("/production-planner/targets"))).toEqual({
      pageKey: "factory/stock-entry",
      tabs: ["hide_tab_stockentry_production_targets"],
    });
  });

  it("returns 403 when an authenticated Factory API has no declared owner", async () => {
    const { res, state } = response();
    const next = vi.fn();

    await enforceFactoryBackendAccess(request("/wave5-unmapped-api"), res, next);

    expect(state.status).toBe(403);
    expect(state.body).toEqual({
      message: "This Factory API has no declared page permission owner.",
      code: "FACTORY_PAGE_ACCESS_DENIED",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when the parent Factory page is denied", async () => {
    accessMocks.authorizeFactoryPageAccess.mockResolvedValue({
      allowed: false,
      code: "FACTORY_PAGE_ACCESS_DENIED",
      message: "You do not have access to this Factory page.",
      state: normalState,
    });
    const { res, state } = response();
    const next = vi.fn();

    await enforceFactoryBackendAccess(request("/accounts"), res, next);

    expect(state.status).toBe(403);
    expect(state.body).toMatchObject({ code: "FACTORY_PAGE_ACCESS_DENIED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when the required Factory tab is hidden", async () => {
    accessMocks.authorizeFactoryPageAccess.mockResolvedValue({
      allowed: true,
      state: {
        ...normalState,
        hiddenTabs: ["hide_tab_daybook_transactions"],
      },
    });
    const { res, state } = response();
    const next = vi.fn();

    await enforceFactoryBackendAccess(request("/daybook"), res, next);

    expect(state.status).toBe(403);
    expect(state.body).toMatchObject({ code: "FACTORY_TAB_ACCESS_DENIED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("allows privileged page access without applying per-user hidden tabs", async () => {
    accessMocks.authorizeFactoryPageAccess.mockResolvedValue({
      allowed: true,
      state: {
        ...normalState,
        role: "Developer",
        privileged: true,
        fullAccess: true,
        hiddenTabs: ["hide_tab_daybook_transactions"],
      },
    });
    const { res } = response();
    const next = vi.fn();

    await enforceFactoryBackendAccess(request("/daybook"), res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
