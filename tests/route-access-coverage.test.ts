import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
  status: "reviewed",
  evidence: ["tests/route-access-coverage.test.ts"],
});
const identities = routeSnapshot.routes.map(routeIdentity);

describe("route access declaration coverage", () => {
  it("requires every actual route to have a declaration", () => {
    const routeSnapshot = JSON.parse(fs.readFileSync("config/route-manifest.json", "utf8"));
    const declarations = JSON.parse(fs.readFileSync("config/route-access-manifest.json", "utf8"));
    expect(validateRouteAccessCoverage(routeSnapshot, declarations)).toEqual([]);
    expect(declarations.rules.length).toBe(routeSnapshot.routes.length);
    const authoritative = JSON.parse(fs.readFileSync("config/route-access-reviewed.json", "utf8"));
    expect(declarations.rules.filter((rule: { status: string }) => rule.status === "reviewed")).toHaveLength(
      authoritative.rules.length
    );
    expect(() =>
      execFileSync(process.execPath, ["scripts/generate-route-access-manifest.mjs", "--check"], {
        stdio: "pipe",
      })
    ).not.toThrow();
  });

  it("refuses unreviewed rules that pretend to authorize traffic directly", () => {
    const routeSnapshot = { routes: ["GET /api/test [handler]"] };
    const id = routeIdentity(routeSnapshot.routes[0], 0);
    const invalid = {
      rules: [{ id, companyScope: "active-company", permission: "allow", roles: ["Admin"], status: "unreviewed" }],
    };
    expect(validateRouteAccessCoverage(routeSnapshot, invalid)).toContain(
      `Unreviewed rule cannot declare direct authorization: ${id}`
    );
  });

  it("refuses a delegated record with forged permissions", () => {
    const routeSnapshot = { routes: ["GET /api/test [handler]"] };
    const id = routeIdentity(routeSnapshot.routes[0], 0);
    const invalid = {
      rules: [{ id, companyScope: "delegated", permission: "all", roles: ["Admin"], enforcement: "legacy-delegated", status: "unreviewed" }],
    };
    expect(validateRouteAccessCoverage(routeSnapshot, invalid)).toContain(
      `Invalid legacy delegation: ${id}`
    );
  });

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
