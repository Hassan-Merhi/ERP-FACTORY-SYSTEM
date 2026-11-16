import { describe, expect, it } from "vitest";

import {
  CompanyIsolationError,
  assertRequestCompanyMatchesSession,
} from "../server/services/security/companyIsolationPolicy";
import { decideExplicitCompanyScope } from "../server/services/security/companyRequestScopePolicy";
import { chooseAuthorizedFactoryCompany } from "../server/services/security/factoryCompanyScopePolicy";

const roles = ["POS", "Normal User", "Manager", "Owner", "Admin", "Developer"] as const;

describe("ERP 90 Phase 3 tenant isolation", () => {
  it("accepts only the server-owned active company as a primary request target", () => {
    for (const role of roles) {
      expect(() => assertRequestCompanyMatchesSession({ userId: "user-1", role, companyId: 10 }, 10)).not.toThrow();
    }
  });

  it("rejects forged cross-company primary targets for every role, including privileged roles", () => {
    for (const role of roles) {
      expect(() => assertRequestCompanyMatchesSession({ userId: "user-1", role, companyId: 10 }, 11)).toThrowError(
        CompanyIsolationError
      );
    }
  });

  it("rejects unauthenticated or invalid company context", () => {
    expect(() => assertRequestCompanyMatchesSession(null, 10)).toThrowError(CompanyIsolationError);
    expect(() =>
      assertRequestCompanyMatchesSession({ userId: "user-1", role: "Admin", companyId: 0 }, 10)
    ).toThrowError(CompanyIsolationError);
  });

  it("treats caller companyId as a requested target and rejects conflicting sources", () => {
    expect(decideExplicitCompanyScope({ queryCompanyId: "10", bodyCompanyId: 10 })).toEqual({
      kind: "company",
      companyId: 10,
    });

    expect(decideExplicitCompanyScope({ queryCompanyId: "10", bodyCompanyId: 11 })).toEqual({
      kind: "conflict",
      companyIds: [10, 11],
    });

    expect(decideExplicitCompanyScope({ bodyCompanyId: "not-a-company" })).toEqual({
      kind: "invalid",
      source: "body",
    });
  });

  it("never accepts an unauthorized pinned Factory company", () => {
    expect(
      chooseAuthorizedFactoryCompany({
        pinnedFactoryId: 99,
        currentCompany: { id: 10, companyType: "factory", active: true },
        assignedFactoryIds: [10, 11],
      })
    ).toBe(10);

    expect(
      chooseAuthorizedFactoryCompany({
        pinnedFactoryId: 99,
        currentCompany: { id: 99, companyType: "factory", active: true },
        assignedFactoryIds: [10, 11],
      })
    ).toBe(10);

    expect(
      chooseAuthorizedFactoryCompany({
        pinnedFactoryId: 99,
        currentCompany: null,
        assignedFactoryIds: [],
      })
    ).toBeNull();
  });
});
