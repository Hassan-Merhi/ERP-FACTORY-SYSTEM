import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { companyQueryKey } from "../client/src/lib/companyQueryScope";

// Read with call arguments joined onto one line, so the assertions hold however
// the formatter wraps a long companyQueryKey(...) call.
const src = (name: string) =>
  readFileSync(resolve(process.cwd(), "client/src/pages/factory", name), "utf8")
    .replace(/\(\s*\n\s*/g, "(")
    .replace(/,\s*\n\s*(?=\S)/g, ", ");

describe("Factory Phase 2 employee company-scoped reads", () => {
  it("isolates employee attendance daily, employee, and picker records", () => {
    const code = src("FactoryEmployeeAttendanceTab.tsx");
    for (const url of [
      "/api/factory/employee-attendance",
      "/api/factory/employee-attendance/employee",
      "/api/factory/employees",
    ]) {
      expect(code).toContain(`companyQueryKey("${url}", selectedCompany?.id`);
    }
    expect(code).toContain("enabled: Boolean(selectedCompany?.id)");
    expect(code).toContain('<PerEmployeeView key={selectedCompany?.id ?? "no-company"} />');
    expect(code).toContain("if (!selectedCompany?.id || !data?.employees?.length) return;");
  });

  it("is company-scoped across employee advances, bonuses and withdrawals", () => {
    for (const file of [
      "FactoryEmployeeAdvancesTab.tsx",
      "FactoryEmployeeBonusesTab.tsx",
      "FactoryEmployeeWithdrawalsTab.tsx",
    ]) {
      const code = src(file);
      expect(code).toContain('companyQueryKey("/api/factory/employees", selectedCompany?.id)');
      expect(code).toContain("enabled: Boolean(selectedCompany?.id)");
      expect(code).not.toContain('queryKey: ["/api/factory/employees"]');
    }
    expect(src("FactoryEmployeeAdvancesTab.tsx")).toContain(
      'companyQueryKey("/api/factory/employee-advances", selectedCompany?.id, statusFilter, empFilter)'
    );
    expect(src("FactoryEmployeeBonusesTab.tsx")).toContain(
      'companyQueryKey("/api/factory/employee-bonuses", selectedCompany?.id, empFilter)'
    );
  });

  it("keys employee list, detail, statement and ledger picker to the company", () => {
    expect(src("FactoryEmployees.tsx")).toContain('companyQueryKey("/api/factory/employees", selectedCompany?.id)');
    const detail = src("FactoryEmployeeDetail.tsx");
    expect(detail).toContain('companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId)');
    expect(detail).toContain('companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId, "statement")');
    expect(detail).toContain(
      'companyQueryKey("/api/ledger-accounts?includeHidden=true&profile=picker", selectedCompany?.id)'
    );
    expect(detail).toContain("enabled: Boolean(selectedCompany?.id) && !!employeeId");
  });

  it("preserves URL prefix and distinct company cache identities", () => {
    const a = companyQueryKey("/api/factory/employees", 101);
    const b = companyQueryKey("/api/factory/employees", 202);
    expect(a[0]).toBe("/api/factory/employees");
    expect(a).not.toEqual(b);
  });
});
