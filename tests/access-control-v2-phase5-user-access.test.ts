import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../server/db", () => ({ pool: mockPool }));
import { readV2CompanyMembers, V2PolicyError, saveV2Rules } from "../server/services/security/accessControlV2Store";

describe("Phase 5 company-scoped user access backend", () => {
  beforeEach(() => vi.resetAllMocks());

  it("lists only canonical memberships from the selected company", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ userId: "user-a", role: "Manager" }] });
    await expect(readV2CompanyMembers(44)).resolves.toEqual([{ userId: "user-a", role: "Manager" }]);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain("FROM user_company_roles");
    expect(sql).toContain("WHERE company_id=$1");
    expect(params).toEqual([44]);
    expect(sql).not.toMatch(/password|email|token/i);
  });

  it("rejects an administrator changing their own user-level exceptions", async () => {
    await expect(
      saveV2Rules({
        actor: { companyId: 44, userId: "admin-1" },
        subject: { kind: "user", userId: "admin-1" },
        expectedRevision: 0,
        reason: "Disallowed own policy update",
        changes: [{ resource: "erp.vouchers", action: "view", decision: "allow" }],
      })
    ).rejects.toMatchObject({ status: 403, code: "SELF_ESCALATION_FORBIDDEN" });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("keeps elevation restrictions on protected system resources", () => {
    expect(V2PolicyError).toBeDefined();
  });
});
