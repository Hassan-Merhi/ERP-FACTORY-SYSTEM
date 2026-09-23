import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("global application language integration", () => {
  it("mounts the language provider for both login and authenticated routes", () => {
    const app = read("client/src/App.tsx");
    expect(app.match(/<ApplicationLanguageProvider>/g)).toHaveLength(2);
    for (const routeScopedProvider of [
      // Login is lazy-loaded (#1600), so the provider wraps its Suspense boundary.
      "<ApplicationLanguageProvider>\n                  <Suspense fallback={<AppLoadingState />}>\n                    <Login />",
      "<ApplicationLanguageProvider>\n      <CompanyProvider>",
    ]) {
      expect(app).toContain(routeScopedProvider);
    }
    expect(app).not.toContain("GlobalLanguageSwitch");
    expect(fs.existsSync(path.join(root, "client/src/components/GlobalLanguageSwitch.tsx"))).toBe(false);
  });

  it("places language selection inside workspace controls without covering company switching", () => {
    const topBar = read("client/src/components/AppTopBar.tsx");
    const workspaceControls = read("client/src/components/MobileWorkspaceControls.tsx");
    const userMenu = read("client/src/components/UserMenu.tsx");
    const companySelector = read("client/src/components/CompanySelector.tsx");

    expect(topBar).toContain("<WorkspaceHeaderControls");
    expect(topBar).toContain("<CompanySelector />");
    expect(topBar.indexOf("<WorkspaceHeaderControls")).toBeLessThan(topBar.indexOf("<CompanySelector />"));
    expect(companySelector).toContain('data-testid="button-company-selector"');

    expect(workspaceControls).toContain("<UserMenu");
    expect(userMenu).toContain("DropdownMenuRadioGroup");
    expect(userMenu).toContain("application-language-${option.value}");
    expect(userMenu).toContain('value: "en"');
    expect(userMenu).toContain('value: "ar"');
    expect(userMenu).toContain('value: "fr"');
    expect(userMenu).not.toContain("fixed right-3 top-3");
    expect(userMenu).not.toContain("z-[70]");
  });

  it("keeps workspace controls available at narrow widths", () => {
    const topBar = read("client/src/components/AppTopBar.tsx");
    expect(topBar).toContain("<MobileWorkspaceControls");
    expect(topBar).toContain("<WorkspaceHeaderControls");
  });

  it("keeps the Factory compatibility component non-visual", () => {
    const factorySwitch = read("client/src/components/FactoryCatalogLanguageSwitch.tsx");
    expect(factorySwitch).toContain("return null");
    expect(factorySwitch).not.toContain("<Button");
  });

  it("registers authenticated language preference endpoints", () => {
    const authRoutes = read("server/routes/authRoutes.ts");
    const preferenceRoutes = read("server/routes/auth/languagePreferenceRoutes.ts");
    expect(authRoutes).toContain("registerLanguagePreferenceRoutes(app)");
    expect(preferenceRoutes).toContain('app.get("/api/language-preference"');
    expect(preferenceRoutes).toContain('app.put("/api/language-preference"');
    expect(preferenceRoutes).toContain("onConflictDoUpdate");
    expect(preferenceRoutes).toContain("target: userLanguagePreferences.userId");
  });
});
