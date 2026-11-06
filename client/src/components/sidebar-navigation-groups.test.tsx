// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ERP_NAV_SECTIONS } from "@/components/AppSidebar";
import { FACTORY_NAV_SECTIONS } from "@/components/FactorySidebar";

function groupFor(
  sections: ReadonlyArray<{ label: string; items: ReadonlyArray<{ url: string }> }>,
  url: string
): string | undefined {
  return sections.find((section) => section.items.some((item) => item.url === url))?.label;
}

describe("sidebar navigation grouping", () => {
  it("shows optional vouchers and profit check within ERP Inventory only", () => {
    expect(groupFor(ERP_NAV_SECTIONS, "/optional-vouchers")).toBe("Inventory");
    expect(groupFor(ERP_NAV_SECTIONS, "/supplier-profit-check")).toBe("Inventory");
    expect(groupFor(ERP_NAV_SECTIONS, "/cost-centers")).toBe("Accounting");
    expect(ERP_NAV_SECTIONS.flatMap((section) => section.items).filter((item) => item.url === "/optional-vouchers"))
      .toHaveLength(1);
  });

  it("moves Bale Explorer into Factory Production", () => {
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/bales-hub")).toBe("Production");
  });

  it("puts Factory stock allocation and sheets & sacks under Inventory", () => {
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/stock-allocation-v5")).toBe("Inventory");
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/sheets-sacks")).toBe("Inventory");
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/location-inventory")).toBe("Inventory");
  });
});
