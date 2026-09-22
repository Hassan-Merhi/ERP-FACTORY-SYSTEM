import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Factory stock-entry two-item limit", () => {
  it("limits Stock Entry to two product lines while allowing any bale quantity", () => {
    const tab = source("client/src/pages/factory/bale-stock-entry/StockEntryTab.tsx");

    expect(tab).toContain("const MAX_ITEMS_PER_ENTRY = 2;");
    expect(tab).toContain("cart.length >= MAX_ITEMS_PER_ENTRY");
    expect(tab).toContain("prev.length >= MAX_ITEMS_PER_ENTRY");
    expect(tab).toContain("cart.length > MAX_ITEMS_PER_ENTRY");
    expect(tab).toContain("Math.max(0, item.qty + delta)");
    expect(tab).toContain("setCart((prev) => prev.map((item) => (item.productId === productId ? { ...item, qty } : item)))");
    expect(tab).not.toContain("MAX_BALES_PER_ENTRY");
    expect(tab).not.toContain("countCartBales");
    expect(tab).not.toContain("maxForProduct");
  });

  it("lets an existing item keep increasing after two product lines are already present", () => {
    const tab = source("client/src/pages/factory/bale-stock-entry/StockEntryTab.tsx");

    expect(tab).toContain("const existingInCart = cart.some((item) => item.productId === product.id);");
    expect(tab).toContain("if (!existingInCart && cart.length >= MAX_ITEMS_PER_ENTRY)");
    expect(tab).toContain("if (existing) {");
    expect(tab).toContain("qty: item.qty + 1");
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
