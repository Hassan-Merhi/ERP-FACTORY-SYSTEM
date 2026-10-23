import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveContext, pageAssignments, errorLog } = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  pageAssignments: vi.fn(),
  errorLog: vi.fn(),
}));

vi.mock("../server/services/security/activeCompanyPermissionContext", () => ({
  getActiveCompanyPermissionContext: resolveContext,
  ActiveCompanyPermissionContextError: class ActiveCompanyPermissionContextError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code: string
    ) {
      super(message);
    }
  },
}));
vi.mock("../server/storage/auth", () => ({ getErpUserPageAccess: pageAssignments }));
vi.mock("../server/lib/logger", () => ({ logger: { error: errorLog } }));

import { enforceCostCenterErpPageAccess } from "../server/middleware/costCenterErpPageAccess";

function makeResponse() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}
async function check(path: string, role: string, grants: string[]) {
  resolveContext.mockResolvedValue({ companyId: 17, userId: "erp-test", role });
  pageAssignments.mockResolvedValue(grants);
  const req = { method: "GET", originalUrl: path } as Request;
  const response = makeResponse();
  const next = vi.fn() as unknown as NextFunction;
  await enforceCostCenterErpPageAccess(req, response, next);
  return { response, next };
}

describe("ERP Cost Center server-side feature authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("denies Owners and Managers without the per-company accounts grant on EVERY ERP route family", async () => {
    const urls = [
      "/api/cost-centers",
      "/api/cost-centers/123/activity",
      "/api/cost-centers/voucher/123/entries",
      "/api/cost-centers/allocations/voucher_entry/123",
      "/api/cost-centers/reports/summary",
      "/api/cost-centers/reports/export?view=accounts&format=csv",
      "/api/cost-centers/reports/consolidated",
      "/api/cost-centers/historical/preview",
      "/api/cost-centers/budgets/123/2026-10",
      "/api/cost-centers/release-readiness",
    ];
    for (const role of ["Owner", "Manager"]) {
      for (const url of urls) {
        const { response, next } = await check(url, role, ["vouchers", "daybook"]);
        expect(response.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      }
    }
    expect(pageAssignments).toHaveBeenCalledWith(17, "erp-test");
  });

  it("allows owners and managers assigned ERP accounts", async () => {
    for (const role of ["Owner", "Manager"]) {
      const { response, next } = await check("/api/cost-centers/reports/summary", role, ["accounts"]);
      expect(next).toHaveBeenCalledOnce();
      expect(response.status).not.toHaveBeenCalled();
    }
  });

  it("preserves Admin and Developer full-access semantics", async () => {
    for (const role of ["Admin", "Developer"]) {
      const { response, next } = await check("/api/cost-centers", role, []);
      expect(next).toHaveBeenCalledOnce();
      expect(response.status).not.toHaveBeenCalled();
    }
    expect(pageAssignments).not.toHaveBeenCalled();
  });

  it("fails closed when the accounts-grant lookup errors", async () => {
    resolveContext.mockResolvedValue({ companyId: 17, userId: "erp-test", role: "Owner" });
    pageAssignments.mockRejectedValue(new Error("Database not ready"));
    const response = makeResponse();
    const next = vi.fn();
    await enforceCostCenterErpPageAccess({} as Request, response, next);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
  });
});
