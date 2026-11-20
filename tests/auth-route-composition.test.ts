import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const compositionPath = path.resolve(process.cwd(), "server/routes/authRoutes.ts");

const focusedRegistrars = [
  "registerCoreAuthRoutes(app)",
  "registerSessionRoutes(app)",
  "registerAuthAuditLogRoutes(app)",
  "registerUserAdministrationRoutes(app)",
  "registerUserAccessRoutes(app)",
  "registerCompanyAccessRoutes(app)",
  "registerUserPresenceRoutes(app)",
  "registerExchangeRateRoutes(app)",
];

describe("auth route composition", () => {
  it("composes every focused auth domain in the entry point", () => {
    const source = fs.readFileSync(compositionPath, "utf8");
    for (const registrar of focusedRegistrars) {
      expect(source.indexOf(registrar)).toBeGreaterThan(-1);
    }
  });

  it("keeps the auth entry point free of retired compatibility registrars", () => {
    const source = fs.readFileSync(compositionPath, "utf8");
    expect(source).not.toContain("registerLegacyAuthRoutes");
    expect(source).not.toContain("authRoutesLegacy");
  });

  it("keeps security-sensitive endpoints in focused modules", () => {
    const core = fs.readFileSync(path.resolve(process.cwd(), "server/routes/auth/coreAuthRoutes.ts"), "utf8");
    const users = fs.readFileSync(
      path.resolve(process.cwd(), "server/routes/auth/userAdministrationRoutes.ts"),
      "utf8"
    );
    const access = fs.readFileSync(path.resolve(process.cwd(), "server/routes/auth/userAccessRoutes.ts"), "utf8");
    const companies = fs.readFileSync(path.resolve(process.cwd(), "server/routes/auth/companyAccessRoutes.ts"), "utf8");
    const audit = fs.readFileSync(path.resolve(process.cwd(), "server/routes/auth/auditLogRoutes.ts"), "utf8");

    expect(core).toContain('app.post("/api/auth/login"');
    expect(core).toContain("req.session.regenerate");
    expect(core).toContain('app.post("/api/auth/confirm-password"');
    // Whitespace-insensitive: the registration is formatted across lines once guards are added.
    expect(users.replace(/\s+/g, "")).toContain('app.post("/api/user-company-roles"');
    expect(access).toContain('app.get("/api/my-locations"');
    expect(companies).toContain('app.post("/api/auth/set-company"');
    expect(audit).toContain('requireExportAccess("exp_audit_log")');
  });
});
