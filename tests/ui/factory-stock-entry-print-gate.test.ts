import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Factory stock-entry two-bale limit", () => {
  it("caps Stock Entry and label printing to two total bales", () => {
    const tab = source("client/src/pages/factory/bale-stock-entry/StockEntryTab.tsx");

    expect(tab).toContain("const MAX_BALES_PER_ENTRY = 2;");
    expect(tab).toContain("countCartBales(cart) >= MAX_BALES_PER_ENTRY");
    expect(tab).toContain("Math.max(0, MAX_BALES_PER_ENTRY - otherQty)");
    expect(tab).toContain("countCartBales(cart) > MAX_BALES_PER_ENTRY");
    expect(tab).toContain("if (countCartBales(prev) >= MAX_BALES_PER_ENTRY) return prev;");
    // The cap message now goes through the application catalog so Arabic and
    // French users see it translated. The English text lives in
    // client/src/i18n/applicationTranslations.ts, where the i18n audit and the
    // catalog's own type constraint keep it in place.
    expect(tab).toContain('tr("factory.stockEntry.baleLimit")');
  });

  it("does not keep the Stock Entry screen locked while print tabs are open", () => {
    const tab = source("client/src/pages/factory/bale-stock-entry/StockEntryTab.tsx");
    const scanner = source("client/src/pages/factory/bale-stock-entry/StockEntryScanner.tsx");

    expect(tab).not.toContain("printGateActive");
    expect(tab).not.toContain("stock-entry-print-lock");
    expect(tab).not.toContain("Close both print tabs before entering another bale");
    expect(scanner).not.toContain("disabled?: boolean");
    expect(scanner).not.toContain("if (disabled)");
  });

  it("keeps the original two print windows without requiring them to close before continuing", () => {
    const tab = source("client/src/pages/factory/bale-stock-entry/StockEntryTab.tsx");

    expect(tab).toContain('a4: window.open("", "_blank")');
    expect(tab).toContain('sticker: window.open("", "_blank")');
    expect(tab).toContain("stockEntryMutation.mutate()");
  });
});
