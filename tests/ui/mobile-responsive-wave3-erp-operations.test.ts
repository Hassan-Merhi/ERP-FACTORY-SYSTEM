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
    // Touch floors are owned by the shared mobile stylesheet (one rule for every shell).
    const compat = source("client/src/mobile-browser-compat.css");
    expect(compat).toContain("--mobile-control-min-height: 2.75rem");
    expect(css).toContain("min-width: 44px");
    expect(css).not.toContain("min-height: 44px !important");
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
    // Each page declares it with the `phone-land` variant instead of a route-scoped override.
    const tailwind = source("tailwind.config.ts");
    expect(tailwind).toContain('"phone-land": { raw: "(hover: none) and (pointer: coarse) and (max-height: 500px)" }');
    for (const file of [
      "client/src/pages/stockitems/StockItemsView.tsx",
      "client/src/pages/StockQuery.tsx",
      "client/src/pages/OptionalVouchers.tsx",
      "client/src/pages/DeletedItems.tsx",
    ]) {
      const contents = source(file);
      expect(contents).toContain("md:hidden phone-land:block");
      expect(contents).toContain("hidden md:block phone-land:hidden");
    }
    const css = source("client/src/erp-mobile-operations.css");
    expect(css).not.toContain('[class~="md:hidden"]');
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
