import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const companiesTab = fs.readFileSync(path.resolve(process.cwd(), "client/src/pages/settings/CompaniesTab.tsx"), "utf8");
const setupPanel = fs.readFileSync(path.resolve(process.cwd(), "client/src/pages/sp/SpSetupPanel.tsx"), "utf8");

describe("Company parent selector", () => {
  // The selector started out as a Supplier Partner affordance. Making parent configuration
  // explicit widened it to every company type that can have an accounting parent, so the
  // gate is now the one type that cannot: "properties".
  it("renders the selector for every parentable company type and excludes the edited company", () => {
    expect(companiesTab).toContain('name="parentCompanyId"');
    expect(companiesTab).toContain('selectedCompanyType !== "properties"');
    expect(companiesTab).toContain("Number(company.id) !== editingCompanyId");
    expect(companiesTab).toContain('data-testid="select-parent-company"');
  });

  it("supports preserving and intentionally clearing the selected parent", () => {
    expect(companiesTab).toContain("parentCompanyId: company.parentCompanyId ?? null");
    expect(companiesTab).toContain('value === "none" ? null : Number(value)');
    expect(companiesTab).toContain("Standalone / No Parent");
  });

  it("sends setup request identities in the format accepted by the accounting guard", () => {
    expect(setupPanel).toContain("const idempotencyKey = createFreshIdempotencyKey");
    expect(setupPanel).toContain("clientRequestId: idempotencyKey");
  });
});
