import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    assignments: [] as Array<{ id: number }>,
  };

  const db = {
    select: vi.fn(() => {
      const builder: any = {};
      builder.from = vi.fn(() => builder);
      builder.where = vi.fn(() => builder);
      builder.limit = vi.fn(async () => state.assignments);
      return builder;
    }),
  };

  return {
    state,
    db,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getClientDate: vi.fn(() => "2026-09-17"),
  };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/lib/logger", () => ({ logger: harness.logger }));
vi.mock("../server/lib/dateUtils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/lib/dateUtils")>();
  return { ...actual, getClientDate: harness.getClientDate };
});

import { canDelete, canModifyDate, checkPOSLocation, requireRole } from "../server/auth";

function responseDouble() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((statusCode: number) => {
    res.statusCode = statusCode;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

function request(
  input: {
    role?: string;
    user?: boolean;
    session?: Record<string, unknown>;
    body?: Record<string, unknown>;
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    path?: string;
    method?: string;
  } = {}
) {
  const hasUser = input.user !== false;
  return {
    user: hasUser
      ? {
          id: "user-1",
          username: "User",
          role: input.role ?? "Manager",
        }
      : undefined,
    session: {
      userId: "user-1",
      username: "User",
      currentCompanyId: 10,
      currentRole: input.role ?? "Manager",
      ...(input.session ?? {}),
    },
    body: input.body ?? {},
    params: input.params ?? {},
    query: input.query ?? {},
    path: input.path ?? "/api/test",
    method: input.method ?? "DELETE",
  } as any;
}

describe("Phase 33E requireRole", () => {
  it("requires an authenticated role", async () => {
    const guard = requireRole("Admin");
    const res = responseDouble();
    const next = vi.fn();

    await guard(request({ user: false }), res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: "Unauthorized" });
    expect(next).not.toHaveBeenCalled();
  });

  it("allows the configured role and always permits Developer", async () => {
    const guard = requireRole("Admin", "Owner");
    const nextAdmin = vi.fn();
    const nextDeveloper = vi.fn();

    await guard(request({ role: "Admin" }), responseDouble(), nextAdmin);
    await guard(request({ role: "Developer" }), responseDouble(), nextDeveloper);

    expect(nextAdmin).toHaveBeenCalledOnce();
    expect(nextDeveloper).toHaveBeenCalledOnce();
  });

  it("denies authenticated roles outside the allowlist", async () => {
    const guard = requireRole("Admin");
    const res = responseDouble();
    const next = vi.fn();

    await guard(request({ role: "Manager" }), res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: "Forbidden" });
    expect(next).not.toHaveBeenCalled();
  });
});

describe("Phase 33E delete permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires authentication", () => {
    const res = responseDouble();
    const next = vi.fn();

    canDelete(request({ user: false }), res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("always allows Developer and Admin", () => {
    const developerNext = vi.fn();
    const adminNext = vi.fn();

    canDelete(request({ role: "Developer" }), responseDouble(), developerNext);
    canDelete(request({ role: "Admin" }), responseDouble(), adminNext);

    expect(developerNext).toHaveBeenCalledOnce();
    expect(adminNext).toHaveBeenCalledOnce();
  });

  it("always blocks Owner and POS deletes even if the session flag is set", () => {
    const owner = responseDouble();
    const pos = responseDouble();

    canDelete(request({ role: "Owner", session: { canDeleteRecords: true } }), owner, vi.fn());
    canDelete(request({ role: "POS", session: { canDeleteRecords: true } }), pos, vi.fn());

    expect(owner.statusCode).toBe(403);
    expect(owner.body).toEqual({ message: "Owners cannot delete records" });
    expect(pos.statusCode).toBe(403);
    expect(pos.body).toEqual({ message: "POS users cannot delete records" });
    expect(harness.logger.error).toHaveBeenCalledTimes(2);
  });

  it("allows the explicit delete flag and gives an unflagged Manager a specific denial", () => {
    const allowedNext = vi.fn();
    const denied = responseDouble();

    canDelete(request({ role: "Manager", session: { canDeleteRecords: true } }), responseDouble(), allowedNext);
    canDelete(request({ role: "Manager", session: { canDeleteRecords: false } }), denied, vi.fn());

    expect(allowedNext).toHaveBeenCalledOnce();
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toEqual({ message: "This manager account does not have delete permission" });
  });

  it("denies other roles that have no explicit delete permission", () => {
    const res = responseDouble();

    canDelete(request({ role: "Normal User", session: { canDeleteRecords: false } }), res, vi.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: "You do not have permission to delete records" });
  });
});

describe("Phase 33E date mutation permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires a user role and lets Admin/Developer bypass date limits", async () => {
    const guard = canModifyDate();
    const unauthorized = responseDouble();
    const adminNext = vi.fn();
    const developerNext = vi.fn();

    await guard(request({ user: false, body: { voucherDate: "2026-01-01" } }), unauthorized, vi.fn());
    await guard(request({ role: "Admin", body: { voucherDate: "2020-01-01" } }), responseDouble(), adminNext);
    await guard(request({ role: "Developer", body: { voucherDate: "2020-01-01" } }), responseDouble(), developerNext);

    expect(unauthorized.statusCode).toBe(401);
    expect(adminNext).toHaveBeenCalledOnce();
    expect(developerNext).toHaveBeenCalledOnce();
  });

  it("allows requests without the configured date field", async () => {
    const next = vi.fn();
    await canModifyDate("customDate")(request({ role: "POS", body: {} }), responseDouble(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("limits POS to today", async () => {
    const guard = canModifyDate();
    const todayNext = vi.fn();
    const old = responseDouble();

    await guard(request({ role: "POS", body: { voucherDate: "2026-09-17" } }), responseDouble(), todayNext);
    await guard(request({ role: "POS", body: { voucherDate: "2026-09-16" } }), old, vi.fn());

    expect(todayNext).toHaveBeenCalledOnce();
    expect(old.statusCode).toBe(403);
    expect(old.body).toEqual({ message: "You can only create or modify records for today's date" });
  });

  it("applies the configured edit-day window to Manager and Owner", async () => {
    const guard = canModifyDate();
    const todayNext = vi.fn();
    const withinNext = vi.fn();
    const zeroWindow = responseDouble();
    const tooOld = responseDouble();
    const future = responseDouble();

    await guard(
      request({ role: "Manager", session: { daybookEditDays: 3 }, body: { voucherDate: "2026-09-17" } }),
      responseDouble(),
      todayNext
    );
    await guard(
      request({ role: "Owner", session: { daybookEditDays: 3 }, body: { voucherDate: "2026-09-15" } }),
      responseDouble(),
      withinNext
    );
    await guard(
      request({ role: "Manager", session: { daybookEditDays: 0 }, body: { voucherDate: "2026-09-16" } }),
      zeroWindow,
      vi.fn()
    );
    await guard(
      request({ role: "Manager", session: { daybookEditDays: 3 }, body: { voucherDate: "2026-09-10" } }),
      tooOld,
      vi.fn()
    );
    await guard(
      request({ role: "Owner", session: { daybookEditDays: 3 }, body: { voucherDate: "2026-09-18" } }),
      future,
      vi.fn()
    );

    expect(todayNext).toHaveBeenCalledOnce();
    expect(withinNext).toHaveBeenCalledOnce();
    expect(zeroWindow.statusCode).toBe(403);
    expect(tooOld.body.message).toContain("within 3 day(s)");
    expect(future.body.message).toContain("within 3 day(s)");
  });

  it("does not impose Manager/POS date policy on unrelated roles", async () => {
    const next = vi.fn();
    await canModifyDate()(
      request({ role: "Normal User", body: { voucherDate: "2020-01-01" } }),
      responseDouble(),
      next
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("Phase 33E POS location isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.assignments = [];
  });

  it("requires a role and bypasses the lookup for non-POS users", async () => {
    const unauthorized = responseDouble();
    const managerNext = vi.fn();

    await checkPOSLocation(request({ user: false }), unauthorized, vi.fn());
    await checkPOSLocation(request({ role: "Manager", params: { locationId: "99" } }), responseDouble(), managerNext);

    expect(unauthorized.statusCode).toBe(401);
    expect(managerNext).toHaveBeenCalledOnce();
    expect(harness.db.select).not.toHaveBeenCalled();
  });

  it("lets POS requests without a usable location id continue to route-level handling", async () => {
    const next = vi.fn();
    await checkPOSLocation(request({ role: "POS", params: { locationId: "bad" } }), responseDouble(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(harness.db.select).not.toHaveBeenCalled();
  });

  it("requires an active company before checking a POS assignment", async () => {
    const res = responseDouble();
    await checkPOSLocation(
      request({ role: "POS", session: { currentCompanyId: null }, params: { locationId: "5" } }),
      res,
      vi.fn()
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: "No company selected" });
  });

  it("permits only locations assigned to the POS user in the active company", async () => {
    harness.state.assignments = [{ id: 1 }];
    const allowedNext = vi.fn();
    await checkPOSLocation(request({ role: "POS", params: { locationId: "5" } }), responseDouble(), allowedNext);
    expect(allowedNext).toHaveBeenCalledOnce();

    harness.state.assignments = [];
    const denied = responseDouble();
    await checkPOSLocation(request({ role: "POS", body: { locationId: 6 } }), denied, vi.fn());
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toEqual({ message: "You can only access data for your assigned locations" });
  });

  it("forwards unexpected assignment lookup errors", async () => {
    const failure = new Error("db failed");
    harness.db.select.mockImplementationOnce(() => {
      throw failure;
    });
    const next = vi.fn();

    await checkPOSLocation(request({ role: "POS", query: { locationId: "7" } }), responseDouble(), next);

    expect(next).toHaveBeenCalledWith(failure);
  });
});
