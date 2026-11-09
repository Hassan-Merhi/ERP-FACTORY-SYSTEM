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

  it("keeps inventory workspaces and moves embedded Overview tabs out of the sidebar", () => {
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/stock-allocation-v5")).toBe("Inventory");
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/location-inventory")).toBe("Inventory");
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/sheets-sacks")).toBeUndefined();
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/monthly-production-matrix")).toBeUndefined();
  });

  it("places comparison links, Stock Query and Tickets in the final Others section", () => {
    const others = FACTORY_NAV_SECTIONS.at(-1);
    expect(others?.label).toBe("Others");
    expect(others?.items.map((item) => item.title)).toEqual([
      "Comparison",
      "Product Comparison",
      "Stock Query",
      "Ticket Management",
    ]);
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/others?tab=comparison")).toBe("Others");
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/others?tab=product-comparison")).toBe("Others");
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/tickets")).toBe("Others");
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/stock-query")).toBe("Others");
  });

  it("combines Factory POS and Waste Dispatch in Sales & Loading", () => {
    const section = FACTORY_NAV_SECTIONS.find((item) => item.label === "Sales & Loading");
    expect(section?.items.filter((item) => item.title === "POS & Dispatch")).toHaveLength(2);
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/waste-dispatch")).toBe("Sales & Loading");
    expect(groupFor(FACTORY_NAV_SECTIONS, "/factory/pos")).toBe("Sales & Loading");
  });
});
