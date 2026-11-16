import { describe, expect, it } from "vitest";
import { routeIdentity, validateRouteAccessCoverage } from "../scripts/verify-route-access-coverage.mjs";

const routeSnapshot = {
  routes: [
    "GET /api/example [requireAuth > handler]",
    "GET /api/example [prerequisite > handler]",
    "POST /api/example [requireAuth > handler]",
  ],
};
const validRule = (id: string) => ({
  id,
  companyScope: "active-company",
  permission: "example.read",
  roles: ["Admin"],
});
const identities = routeSnapshot.routes.map(routeIdentity);

describe("route access declaration coverage", () => {
  it("preserves repeated method/path registration identity", () => {
    expect(new Set(identities).size).toBe(3);
    expect(identities[0]).toBe("0:GET /api/example [requireAuth > handler]");
    expect(identities[1]).toBe("1:GET /api/example [prerequisite > handler]");
  });

  it("accepts explicitly declared and valid registration rules", () => {
    expect(validateRouteAccessCoverage(routeSnapshot, { rules: identities.map(validRule) })).toEqual([]);
  });

  it("rejects guard-chain drift even if method/path stay the same", () => {
    const changed = { routes: [...routeSnapshot.routes] };
    changed.routes[0] = "GET /api/example [handler]";
    const errors = validateRouteAccessCoverage(changed, { rules: identities.map(validRule) });
    expect(errors.some(error => error.startsWith("Missing access declaration: 0:"))).toBe(true);
    expect(errors.some(error => error.startsWith("Stale access declaration: 0:"))).toBe(true);
  });

  it("fails when any individual route lacks a declaration", () => {
    const errors = validateRouteAccessCoverage(routeSnapshot, { rules: identities.slice(1).map(validRule) });
    expect(errors).toContain(`Missing access declaration: ${identities[0]}`);
  });

  it("fails on missing role, permission, or company scope", () => {
    const rules = identities.map(validRule);
    rules[0].roles = [];
    rules[1].permission = "";
    rules[2].companyScope = "any" as "active-company";
    const errors = validateRouteAccessCoverage(routeSnapshot, { rules });
    expect(errors).toEqual(
      expect.arrayContaining([
        `Missing/invalid role declaration: ${identities[0]}`,
        `Missing permission declaration: ${identities[1]}`,
        `Invalid company scope: ${identities[2]}`,
      ])
    );
  });

  it("fails on duplicate or stale registrations", () => {
    const rules = [...identities.map(validRule), validRule(identities[0]), validRule("99:GET /api/missing")];
    const errors = validateRouteAccessCoverage(routeSnapshot, { rules });
    expect(errors).toContain(`Duplicate access declaration: ${identities[0]}`);
    expect(errors).toContain("Stale access declaration: 99:GET /api/missing");
  });
});
