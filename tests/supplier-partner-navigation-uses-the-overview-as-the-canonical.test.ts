import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("Supplier Partner navigation phase 2", () => {
  it("uses the overview as the canonical Supplier Partner landing route", () => {
    const routes = read("client/src/routes/ErpRoutes.tsx");
    expect(routes).toContain('import SpOverview from "@/pages/sp/SpOverview"');
    expect(routes).toContain('<Route path="/sp" component={SpOverview} />');
  });

  it("keeps setup inside the Supplier Partner section", () => {
    const navigation = read("client/src/lib/supplier-partner-navigation.ts");
    expect(navigation).toContain('label: "Supplier Partner"');
    expect(navigation).not.toContain('label: "SP Administration"');
    expect(navigation).not.toContain('{ title: "Overview", url: "/sp"');
    expect(navigation).toContain('{ title: "Setup", url: "/sp/setup"');
  });

  it("registers Supplier Partner pages for recent navigation", () => {
    const sidebar = read("client/src/components/AppSidebar.tsx");
    expect(sidebar).toContain("SUPPLIER_PARTNER_RECENT_ITEMS");
    expect(sidebar).toContain('selectedCompany?.companyType === "supplier_partner"');
    expect(sidebar).toContain("SUPPLIER_PARTNER_SECTIONS");
  });

  it("keeps operational lifecycle controls explicit on the overview", () => {
    const overview = read("client/src/pages/sp/SpOverview.tsx");
    expect(overview).toContain("/api/sp/sales");
    expect(overview).toContain('data-testid="confirm-reverse-sp-sale"');
    expect(overview).toContain("reverseSale.mutate()");
  });
});
