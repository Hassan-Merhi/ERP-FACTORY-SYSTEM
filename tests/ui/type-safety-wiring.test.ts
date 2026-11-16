import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Phase 9 type-safety wiring", () => {
  it("centralizes typed authenticated-user and company-session queries", () => {
    const queries = source("client/src/contracts/sessionQueryContracts.ts");
    const authHook = source("client/src/app/useAuthenticatedUser.ts");
    const companyContext = source("client/src/contexts/CompanyContext.tsx");

    expect(queries).toContain("fetchAuthenticatedUser");
    expect(queries).toContain("fetchUserCompanies");
    expect(queries).toContain("fetchSessionCompany");
    expect(queries).toContain("parseAuthenticatedUser");
    expect(queries).toContain("parseUserCompanies");
    expect(queries).toContain("parseSessionCompany");
    expect(queries).toContain("authenticatedUserQueryOptions");
    expect(queries).toContain("userCompaniesQueryOptions");

    expect(authHook).toContain("useQuery(authenticatedUserQueryOptions())");
    expect(authHook).not.toContain("useQuery<any>");
    expect(authHook).toContain("logoutError: unknown");

    expect(companyContext).toContain("useQuery(userCompaniesQueryOptions())");
    expect(companyContext).toContain("fetchSessionCompany()");
    expect(companyContext).not.toContain("useQuery<any[]>");
    expect(companyContext).toContain("export interface Company");
    expect(companyContext).toContain("createCompanySwitchQueue");
    expect(companyContext).toContain("companyDataKey(url, companyId)");
  });

  it("renders an explicit company-contract failure without bypassing context switching", () => {
    const selector = source("client/src/components/CompanySelector.tsx");

    expect(selector).toContain("company: Company");
    expect(selector).toContain("error: companyError");
    expect(selector).toContain("button-company-selector-error");
    expect(selector).toContain("await selectCompany(company");
    expect(selector).not.toContain("company: any");
    expect(selector).not.toContain("as any");
    expect(selector).not.toContain("error: any");
    expect(selector).not.toContain("window.location.reload");
  });

  it("uses the shared auth contract and selected company in GIT containers", () => {
    const page = source("client/src/pages/GITContainers.tsx");
    const localTypes = source("client/src/pages/git-containers/gitContainerTypes.ts");

    expect(page).toContain("useQuery(authenticatedUserQueryOptions())");
    expect(page).toContain("const { selectedCompany } = useCompany()");
    expect(page).toContain("selectedCompany?.id ?? \"no-company\"");
    expect(page).not.toContain("useQuery<AuthUser>");
    expect(page).not.toContain("catch (err: any)");
    expect(localTypes).not.toContain("export interface AuthUser");
  });

  it("returns the current session permissions from auth/me", () => {
    const route = source("server/routes/auth/coreAuthRoutes.ts");

    for (const field of [
      "currentRole",
      "currentCompanyId",
      "currentLocationId",
      "currentPOSStation",
      "canSellNegativeStock",
      "posViewOnly",
      "daybookEditDays",
      "canAccessCustomers",
      "canDeleteRecords",
    ]) {
      expect(route).toContain(field);
    }
  });
});
