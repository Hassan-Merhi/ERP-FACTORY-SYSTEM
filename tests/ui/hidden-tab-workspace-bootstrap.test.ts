import { describe, expect, it } from "vitest";
import { isWorkspaceBootstrapRead, shouldDeferUntilVisible } from "@/lib/requestStormGuardAcquireGetSlot";

describe("background-tab request deferral", () => {
  it("lets the reads that mount a workspace through while the tab is hidden", () => {
    // A background tab that follows another tab's company switch needs these
    // to leave its loading screen; they are cached for minutes otherwise.
    for (const path of [
      "/api/factory/my-access",
      "/api/factory/settings",
      "/api/company-settings",
      "/api/my-permissions",
      "/api/my-erp-pages",
      "/api/user-preferences",
      "/api/companies/31",
    ]) {
      expect(isWorkspaceBootstrapRead(path), path).toBe(true);
      expect(shouldDeferUntilVisible(path, 5 * 60_000), path).toBe(false);
    }
  });

  it("still holds page data until the tab is opened", () => {
    expect(shouldDeferUntilVisible("/api/suppliers", 60_000)).toBe(true);
    expect(shouldDeferUntilVisible("/api/factory/customer-orders", 0)).toBe(true);
    expect(shouldDeferUntilVisible("/api/factory/raw-stock", 0)).toBe(true);
    expect(isWorkspaceBootstrapRead("/api/companies")).toBe(false);
    expect(isWorkspaceBootstrapRead("/api/companies/31/settings")).toBe(false);
  });

  it("does not defer uncached reads", () => {
    expect(shouldDeferUntilVisible("/api/vouchers", 0)).toBe(false);
  });
});
