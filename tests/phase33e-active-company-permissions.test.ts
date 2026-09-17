import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    rows: [] as Array<Record<string, unknown>>,
  };

  const db = {
    select: vi.fn(() => {
      const builder: any = {};
      builder.from = vi.fn(() => builder);
      builder.where = vi.fn(async () => state.rows);
      return builder;
    }),
  };

  return { state, db };
});

vi.mock("../server/db", () => ({ db: harness.db }));

import {
  chooseActiveCompanyRole,
  isPinnedCompanyRoute,
  resolvePermissionCompanyId,
} from "../server/services/security/activeCompanyPermissionPolicy";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../server/services/security/activeCompanyPermissionContext";

function request(overrides: Record<string, unknown> = {}) {
  return {
    path: "/api/vouchers",
    originalUrl: "/api/vouchers",
    session: {
      userId: "user-1",
      currentCompanyId: 10,
      factoryCompanyId: 20,
    },
    ...overrides,
  } as any;
}

describe("Phase 33E active-company permission policy", () => {
  it("pins real Factory and Properties routes but leaves ERP container aliases on the ERP company", () => {
    expect(isPinnedCompanyRoute("/api/factory")).toBe(true);
    expect(isPinnedCompanyRoute("/api/factory/stock/location/3")).toBe(true);
    expect(isPinnedCompanyRoute("/api/properties/leases")).toBe(true);
    expect(isPinnedCompanyRoute("/api/vouchers")).toBe(false);
    expect(isPinnedCompanyRoute("/api/factory/containers/123/documents")).toBe(false);
    expect(isPinnedCompanyRoute("/api/factory/containers/123/freight?mode=all")).toBe(false);
  });

  it("resolves the canonical company from the route family and rejects invalid cached ids", () => {
    expect(
      resolvePermissionCompanyId({
        path: "/api/factory/raw-stock",
        currentCompanyId: 10,
        factoryCompanyId: 20,
      })
    ).toBe(20);
    expect(
      resolvePermissionCompanyId({
        path: "/api/factory/raw-stock",
        currentCompanyId: 10,
        factoryCompanyId: null,
      })
    ).toBe(10);
    expect(
      resolvePermissionCompanyId({
        path: "/api/pos/sales",
        currentCompanyId: 10,
        factoryCompanyId: 20,
      })
    ).toBe(10);
    expect(
      resolvePermissionCompanyId({
        path: "/api/vouchers",
        currentCompanyId: "not-an-id",
        factoryCompanyId: 20,
      })
    ).toBeNull();
  });

  it("prefers the role assigned to the active company and only uses Developer as the cross-company bypass", () => {
    expect(
      chooseActiveCompanyRole(10, [
        { companyId: 10, role: "Manager" },
        { companyId: 20, role: "Developer" },
      ])
    ).toEqual({ role: "Manager", developerBypass: false });

    expect(
      chooseActiveCompanyRole(30, [
        { companyId: 10, role: "Manager" },
        { companyId: 20, role: "Developer" },
      ])
    ).toEqual({ role: "Developer", developerBypass: true });

    expect(chooseActiveCompanyRole(30, [{ companyId: 10, role: "Admin" }])).toBeNull();
  });
});

describe("Phase 33E canonical active-company role context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.rows = [];
  });

  it("returns a cached canonical context without re-querying company roles", async () => {
    const cached = {
      userId: "cached-user",
      companyId: 9,
      role: "Owner",
      developerBypass: false,
      assignedLocationId: 3,
      cashAccountId: 4,
      posStation: null,
      canSellNegativeStock: true,
      posViewOnly: false,
      daybookEditDays: 2,
      canAccessCustomers: true,
      canDeleteRecords: false,
    };
    const req = request({ _activeCompanyPermissionContext: cached });

    await expect(getActiveCompanyPermissionContext(req)).resolves.toBe(cached);
    expect(harness.db.select).not.toHaveBeenCalled();
  });

  it("fails closed when either the user or active company context is missing", async () => {
    await expect(
      getActiveCompanyPermissionContext(
        request({
          session: { userId: undefined, currentCompanyId: 10, factoryCompanyId: 20 },
        })
      )
    ).rejects.toMatchObject({
      name: "ActiveCompanyPermissionContextError",
      status: 401,
      code: "ACTIVE_COMPANY_CONTEXT_REQUIRED",
    });

    await expect(
      getActiveCompanyPermissionContext(
        request({
          session: { userId: "user-1", currentCompanyId: 0, factoryCompanyId: null },
        })
      )
    ).rejects.toBeInstanceOf(ActiveCompanyPermissionContextError);
  });

  it("hydrates the exact company role and operational permission fields", async () => {
    harness.state.rows = [
      {
        companyId: 10,
        role: "Manager",
        assignedLocationId: 7,
        cashAccountId: 8,
        posStation: 2,
        canSellNegativeStock: true,
        posViewOnly: true,
        daybookEditDays: 5,
        canAccessCustomers: true,
        canDeleteRecords: true,
      },
      {
        companyId: 20,
        role: "Owner",
        assignedLocationId: null,
        cashAccountId: null,
        posStation: null,
        canSellNegativeStock: false,
        posViewOnly: false,
        daybookEditDays: 0,
        canAccessCustomers: false,
        canDeleteRecords: false,
      },
    ];
    const req = request();

    await expect(getActiveCompanyPermissionContext(req)).resolves.toEqual({
      userId: "user-1",
      companyId: 10,
      role: "Manager",
      developerBypass: false,
      assignedLocationId: 7,
      cashAccountId: 8,
      posStation: 2,
      canSellNegativeStock: true,
      posViewOnly: true,
      daybookEditDays: 5,
      canAccessCustomers: true,
      canDeleteRecords: true,
    });
    expect(req._activeCompanyPermissionContext).toEqual(expect.objectContaining({ companyId: 10, role: "Manager" }));
  });

  it("uses the pinned Factory company rather than a simultaneous ERP tab company", async () => {
    harness.state.rows = [
      {
        companyId: 10,
        role: "Admin",
        assignedLocationId: null,
        cashAccountId: null,
        posStation: null,
        canSellNegativeStock: false,
        posViewOnly: false,
        daybookEditDays: 0,
        canAccessCustomers: false,
        canDeleteRecords: false,
      },
      {
        companyId: 20,
        role: "Owner",
        assignedLocationId: 99,
        cashAccountId: 77,
        posStation: null,
        canSellNegativeStock: false,
        posViewOnly: false,
        daybookEditDays: 3,
        canAccessCustomers: true,
        canDeleteRecords: false,
      },
    ];
    const req = request({ path: "/api/factory/bales", originalUrl: "/api/factory/bales?status=open" });

    await expect(getActiveCompanyPermissionContext(req)).resolves.toMatchObject({
      companyId: 20,
      role: "Owner",
      assignedLocationId: 99,
      cashAccountId: 77,
      daybookEditDays: 3,
    });
  });

  it("gives a Developer assigned elsewhere the documented all-company bypass defaults", async () => {
    harness.state.rows = [
      {
        companyId: 20,
        role: "Developer",
        assignedLocationId: 4,
        cashAccountId: 5,
        posStation: 6,
        canSellNegativeStock: false,
        posViewOnly: true,
        daybookEditDays: 1,
        canAccessCustomers: false,
        canDeleteRecords: false,
      },
    ];

    await expect(getActiveCompanyPermissionContext(request())).resolves.toEqual({
      userId: "user-1",
      companyId: 10,
      role: "Developer",
      developerBypass: true,
      assignedLocationId: null,
      cashAccountId: null,
      posStation: null,
      canSellNegativeStock: true,
      posViewOnly: false,
      daybookEditDays: 9999,
      canAccessCustomers: true,
      canDeleteRecords: true,
    });
  });

  it("rejects stale sessions whose user no longer has a role for the active company", async () => {
    harness.state.rows = [
      {
        companyId: 20,
        role: "Manager",
        assignedLocationId: null,
        cashAccountId: null,
        posStation: null,
        canSellNegativeStock: false,
        posViewOnly: false,
        daybookEditDays: 0,
        canAccessCustomers: false,
        canDeleteRecords: false,
      },
    ];

    await expect(getActiveCompanyPermissionContext(request())).rejects.toMatchObject({
      name: "ActiveCompanyPermissionContextError",
      status: 403,
      code: "ACTIVE_COMPANY_ROLE_REQUIRED",
    });
  });
});
