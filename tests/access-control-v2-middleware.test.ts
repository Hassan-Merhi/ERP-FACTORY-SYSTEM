import { beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../server/services/security/activeCompanyPermissionContext", () => ({
  getActiveCompanyPermissionContext: context.get,
  ActiveCompanyPermissionContextError: class ActiveCompanyPermissionContextError extends Error {
    constructor(
      message: string,
      public readonly status: 401 | 403,
      public readonly code: string
    ) {
      super(message);
    }
  },
}));
import { requireVerifiedBusinessAction } from "../server/services/security/accessControlV2Enforcement";

// The guard reads the session role and the tenant boundary's canonical role;
// these requests carry a Create Only session, as the outer guard requires.
const req = (body: unknown = {}) => ({ body, session: { currentRole: "Create Only" } }) as never;
function response() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
}

describe("Phase 7 permission middleware bypass and transaction boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    context.get.mockResolvedValue({
      role: "Create Only",
      companyId: 7,
      developerBypass: false,
    });
  });
  it("allows a newly created company-scoped record through a reviewed route", async () => {
    const next = vi.fn();
    const res = response();
    await requireVerifiedBusinessAction({
      resource: "erp.suppliers",
      action: "create",
      handlerVerified: true,
    })(req(), res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
  it("denies reverse, delete, finalize, edit and import without dispatching to handler", async () => {
    for (const action of ["edit", "delete", "finalize", "reverse", "import", "approve", "void"] as const) {
      const next = vi.fn();
      const res = response();
      await requireVerifiedBusinessAction({
        resource: "factory.containers",
        action,
        handlerVerified: true,
      })(req(), res as never, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });
  it("blocks POST create that touches an existing record", async () => {
    const next = vi.fn();
    const res = response();
    await requireVerifiedBusinessAction({
      resource: "erp.suppliers",
      action: "create",
      handlerVerified: true,
      editsExistingRecord: () => true,
    })(req(), res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
  it("protected period or transaction state beats a create grant", async () => {
    const next = vi.fn();
    const res = response();
    await requireVerifiedBusinessAction({
      resource: "erp.suppliers",
      action: "create",
      handlerVerified: true,
      hardDenied: () => true,
    })(req(), res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
  it("denies invalid company scope even if role was otherwise allowed", async () => {
    context.get.mockResolvedValueOnce({ role: "Create Only", companyId: 0, developerBypass: false });
    const next = vi.fn();
    const res = response();
    await requireVerifiedBusinessAction({
      resource: "erp.suppliers",
      action: "create",
      handlerVerified: true,
    })(req(), res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
  it("does not allow a failing company lookup to reach the write handler", async () => {
    context.get.mockRejectedValueOnce(new Error("database unavailable"));
    const next = vi.fn();
    const res = response();
    await requireVerifiedBusinessAction({
      resource: "erp.suppliers",
      action: "create",
      handlerVerified: true,
    })(req(), res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(res.status).not.toHaveBeenCalled();
  });
  it("preserves existing roles, leaving legacy route guards authoritative", async () => {
    context.get.mockResolvedValueOnce({ role: "Manager", companyId: 7, developerBypass: false });
    const next = vi.fn();
    await requireVerifiedBusinessAction({
      resource: "erp.suppliers",
      action: "delete",
      handlerVerified: true,
    })(req(), response() as never, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
