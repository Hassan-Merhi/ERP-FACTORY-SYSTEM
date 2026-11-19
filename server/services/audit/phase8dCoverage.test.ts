import { describe, expect, it } from "vitest";

import { hasAwaitedAuditWrite, moduleSource } from "./auditCoverageSource";

/**
 * Same shape as the Phase 8C list next door, for the admin and account
 * mutations Phase 8D was meant to cover. AUDITED keeps its wiring; UNAUDITED is
 * the outstanding work, asserted exactly so neither set moves by accident.
 */
const AUDITED = ["server/routes/admin/userManagementRoutes.ts"];

const UNAUDITED = [
  // No reference to logAudit at all.
  "server/routes/accounts",
  "server/routes/admin/repair",
  // Import present, no call site.
  "server/routes/admin/companySettingsRoutes.ts",
  "server/routes/admin/import-export",
];

describe("Phase 8D audit coverage", () => {
  it.each(AUDITED)("keeps %s connected to awaited audit writes", (modulePath) => {
    expect(hasAwaitedAuditWrite(modulePath)).toBe(true);
  });

  it.each(UNAUDITED)("records %s as a known gap in admin audit coverage", (modulePath) => {
    expect(
      hasAwaitedAuditWrite(modulePath),
      `${modulePath} now has awaited audit writes. Move it from UNAUDITED to AUDITED ` + "so the gain is locked in."
    ).toBe(false);
  });

  it("keeps the compatibility adapter connected to the shared audit framework", () => {
    const contents = moduleSource("server/routes/helpers/auditWriteAdapter.ts");

    expect(contents).toContain('from "../../services/audit"');
    expect(contents).toMatch(/await\s+writeAuditEvent\s*\(/);
  });

  it("keeps the reviewed payroll exception visible until atomic integration is possible", () => {
    // These handlers left employeeRoutes.ts when payrollRoutes.ts was split;
    // reading the directory means the assertion follows them.
    const payroll = moduleSource("server/routes/erp-payroll");
    const guidance = moduleSource("docs/archive/phase-8d-domain-auditing.md");

    // Whitespace-insensitive: Prettier may wrap a registration onto several lines.
    const compactPayroll = payroll.replace(/\s+/g, "");
    expect(compactPayroll).toContain('app.post("/api/payroll/runs"');
    expect(compactPayroll).toContain('app.patch("/api/payroll/runs/:id"');
    expect(compactPayroll).toContain('app.post("/api/payroll/runs/:id/undo"');
    expect(guidance).toContain("documented safety exception");
    expect(guidance).toContain("legacy multi-step payroll mutations");
  });
});
