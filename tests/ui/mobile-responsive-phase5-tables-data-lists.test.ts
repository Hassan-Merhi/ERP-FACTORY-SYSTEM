import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Mobile responsiveness Phase 5 tables and data lists", () => {
  it("keeps shared tables inside an accessible horizontal viewport", () => {
    const table = source("client/src/components/ui/table.tsx");

    expect(table).toContain('role="region"');
    expect(table).toContain('data-horizontal-scroll="true"');
    expect(table).toContain('data-table-scroll-region="true"');
    expect(table).toContain("touch-pan-x");
    expect(table).toContain("overscroll-x-contain");
    expect(table).toContain("focus-visible:ring-2");
    expect(table).toContain("minimumWidth");
    expect(table).toContain("sm:h-8");
    expect(table).toContain("sm:py-1");
  });

  it("provides semantic mobile data-list building blocks", () => {
    const dataList = source("client/src/components/ui/responsive-data-list.tsx");

    expect(dataList).toContain("ResponsiveDataList");
    expect(dataList).toContain("ResponsiveDataListItem");
    expect(dataList).toContain("ResponsiveDataListFields");
    expect(dataList).toContain("ResponsiveDataListField");
    expect(dataList).toContain("ResponsiveDataListActions");
    expect(dataList).toContain("ResponsiveDataListEmpty");
    expect(dataList).toContain('data-mobile-data-list="true"');
    expect(dataList).toContain("<dt");
    expect(dataList).toContain("<dd");
    expect(dataList).toContain("*:min-h-11");
  });

  it("keeps pagination usable on narrow touch screens", () => {
    const pagination = source("client/src/components/ui/pagination.tsx");

    expect(pagination).toContain("overflow-x-auto");
    expect(pagination).toContain("min-w-max");
    expect(pagination).toContain("min-h-11 min-w-11");
    expect(pagination).toContain('className="hidden sm:inline"');
    expect(pagination).toContain('aria-label="Go to previous page"');
    expect(pagination).toContain('aria-label="Go to next page"');
  });

  it("standardizes generic horizontal scroll regions", () => {
    const accessibility = source("client/src/components/ui/responsive-accessibility.tsx");

    expect(accessibility).toContain('data-horizontal-scroll="true"');
    expect(accessibility).toContain('data-horizontal-scroll-region="true"');
    expect(accessibility).toContain("aria-describedby");
    expect(accessibility).toContain("touch-pan-x");
  });

  it("keeps shared display primitives free from ERP business behavior", () => {
    const sharedSources = [
      "client/src/components/ui/table.tsx",
      "client/src/components/ui/pagination.tsx",
      "client/src/components/ui/responsive-data-list.tsx",
      "client/src/components/ui/responsive-accessibility.tsx",
    ].map(source);

    for (const contents of sharedSources) {
      for (const forbidden of [
        "/api/",
        "useMutation(",
        "useQuery(",
        "queryClient",
        "ledgerAccount",
        "costPerKg",
        "stockQuantity",
      ]) {
        expect(contents).not.toContain(forbidden);
      }
    }
  });
});
