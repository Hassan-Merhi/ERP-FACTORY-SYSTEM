import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Mobile Wave 3 ERP operational workflows", () => {
  it("scopes phone behavior to ERP routes without changing tablet/desktop breakpoints", () => {
    const shell = source("client/src/app/ErpShell.tsx");
    const css = source("client/src/erp-mobile-operations.css");

    expect(shell).toContain('import "@/erp-mobile-operations.css"');
    expect(shell).toContain("data-erp-route={routePath}");
    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain("@media (hover: none) and (pointer: coarse) and (max-height: 500px)");
    expect(css).toContain("min-height: 44px !important");
    expect(css).toContain("min-width: 44px");
  });

  it("keeps the main ERP hubs horizontally contained on phones", () => {
    for (const file of [
      "client/src/pages/InventoryHub.tsx",
      "client/src/pages/StockHub.tsx",
      "client/src/pages/SalesToolsHub.tsx",
      "client/src/pages/PartiesHub.tsx",
    ]) {
      const contents = source(file);
      expect(contents).toContain("erp-mobile-scroll-tabs");
      expect(contents).toContain("shrink-0");
    }
  });

  it("stacks container rows and filters without hiding touch actions", () => {
    const rows = source("client/src/pages/containers/ActiveContainersTable.tsx");
    const filters = source("client/src/pages/containers/ContainerFilters.tsx");

    expect(rows).toContain("flex flex-col gap-3 hover-elevate sm:flex-row");
    expect(rows).toContain("erp-mobile-touch-visible erp-mobile-touch-target");
    expect(rows).toContain('className="w-full sm:w-auto"');
    expect(filters).toContain("w-full min-w-0 sm:flex-1 sm:min-w-[200px]");
    expect(filters).toContain("overflow-x-auto");
  });

  it("stacks transaction journal filters and search controls on phones", () => {
    const filters = source("client/src/pages/transactionjournal/components/JournalFilters.tsx");

    expect(filters).toContain('className="w-full sm:w-[150px]"');
    expect(filters).toContain('className="w-full sm:w-[110px]"');
    expect(filters).toContain('className="w-full sm:w-[130px]"');
    expect(filters).toContain('className="flex flex-col gap-2 sm:flex-row"');
  });

  it("keeps existing mobile data alternatives active on landscape phones", () => {
    const css = source("client/src/erp-mobile-operations.css");
    expect(css).toContain('[data-erp-route="/inventory"] [class~="md:hidden"]');
    expect(css).toContain('[data-erp-route="/stock"] [class~="md:hidden"]');
    expect(css).toContain('[data-erp-route="/sales-tools"] [class~="md:hidden"]');
    expect(css).toContain('[data-erp-route="/optional-vouchers"] [class~="md:hidden"]');
    expect(css).toContain('[class~="hidden"][class~="md:block"]');
  });

  it("does not move accounting or inventory business rules into Wave 3 mobile code", () => {
    const css = source("client/src/erp-mobile-operations.css");
    const verifier = source("scripts/verify-mobile-responsive-wave3-erp-operations.mjs");
    for (const forbidden of ["useMutation(", "debitAmount =", "creditAmount =", "costPerKg =", 'fetch("/api/']) {
      expect(css).not.toContain(forbidden);
      expect(verifier).not.toContain(forbidden);
    }
  });
});
