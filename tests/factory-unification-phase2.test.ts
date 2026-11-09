import { describe, expect, it } from "vitest";
import { factoryActionCapabilities } from "../shared/factoryActionCapabilities";
import { companyQueryKey, isCompanySessionQueryKey } from "../client/src/lib/companyQueryScope";

describe("Factory Phase 2 action permissions", () => {
  const cases = [
    { role: "View Only", close: false, approve: false, reopen: false, bonuses: false },
    { role: "Create Only", close: false, approve: false, reopen: false, bonuses: false },
    { role: "User", close: true, approve: false, reopen: false, bonuses: false },
    { role: "Admin", close: true, approve: true, reopen: true, bonuses: true },
    { role: "Owner", close: true, approve: true, reopen: true, bonuses: true },
    { role: "Developer", close: true, approve: true, reopen: true, bonuses: false },
  ] as const;
  for (const row of cases) {
    it(`preserves ${row.role} dispatch and bonus action policy`, () => {
      const caps = factoryActionCapabilities({ role: row.role, hasFactoryAccess: true });
      expect(caps["dispatch.close"]).toBe(row.close);
      expect(caps["dispatch.approve-discrepancy"]).toBe(row.approve);
      expect(caps["dispatch.reopen"]).toBe(row.reopen);
      expect(caps["production.manage-bonuses"]).toBe(row.bonuses);
    });
  }
  it("denies all actions while access is unavailable or explicitly refused", () => {
    for (const role of ["Admin", "Owner", "Developer", "User"]) {
      const caps = factoryActionCapabilities({ role, hasFactoryAccess: false });
      expect(Object.values(caps).every((allowed) => allowed === false)).toBe(true);
    }
    expect(Object.values(factoryActionCapabilities({ role: "" })).every((allowed) => !allowed)).toBe(true);
  });
});

describe("Factory Phase 2 company query isolation", () => {
  it("separates container and OTW records between companies", () => {
    const first = companyQueryKey("/api/factory/containers", 10);
    const second = companyQueryKey("/api/factory/containers", 20);
    const otw = companyQueryKey("/api/factory/containers", 10, "otw");
    expect(first).not.toEqual(second);
    expect(otw.slice(0, first.length)).toEqual(first);
  });
  it("classifies factory data as session-bound, not global", () => {
    expect(isCompanySessionQueryKey(companyQueryKey("/api/factory/settings", 10))).toBe(true);
    expect(isCompanySessionQueryKey(["/api/auth/me"])).toBe(false);
  });
});
