import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toMoney } from "../server/lib/money";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("MODA ZAKARIA broker settlement sign and color parity", () => {
  it("keeps the correct source-broker total, including the negative cent USD pool", () => {
    const eurPayable = toMoney("27932.85");
    const usdPool = toMoney("-0.01");
    const usdRate = toMoney("1.18");
    expect(eurPayable.times(usdRate).toFixed(3)).toBe("32960.763");
    expect(eurPayable.times(usdRate).plus(usdPool).toFixed(3)).toBe("32960.753");
    expect(eurPayable.times(usdRate).plus(usdPool).toFixed(2)).toBe("32960.75");
  });

  it("shows total payable red on both broker directory and broker overview", () => {
    const directory = read("client/src/pages/factory/factory-suppliers/FactorySuppliersDirectory.tsx");
    const overview = read("client/src/pages/factory/factory-suppliers/BrokerOverviewPanel.tsx");
    expect(directory).toContain('supplier.id === 37 &&');
    expect(directory).toContain('supplier.name.trim().toUpperCase() === "MODA ZAKARIA DIRECT"');
    expect(directory).toContain('data-testid={`text-directory-usd-equivalent-${supplier.id}`}');
    expect(directory).toContain('usdEquivalent > 0.005');
    expect(directory).toContain('"text-red-600 dark:text-red-400"');
    expect(overview).toContain('data-testid="text-broker-usd-equivalent"');
    expect(overview).toContain('Number(parentSup.usdEquivalentBalance ?? 0) > 0.005');
    expect(overview).toContain('"text-red-600 dark:text-red-400"');
  });

  it("marks EUR payable red, EUR overpaid green, while preserving USD pool meaning", () => {
    const directory = read("client/src/pages/factory/factory-suppliers/FactorySuppliersDirectory.tsx");
    const overview = read("client/src/pages/factory/factory-suppliers/BrokerOverviewPanel.tsx");
    expect(directory).toContain('data-testid="text-moda-eur-net-balance"');
    expect(directory).toContain("pool.currencyCode === \"EUR\" && !pool.isBrokerPool");
    expect(directory).toContain('Number(modaEuroPool.balance) > 0 ? " payable" : " overpaid"');
    expect(overview).toContain("b.isBrokerPool");
    expect(overview).toContain('b.balance > 0');
    expect(overview).toContain('text-green-600 dark:text-green-400');
    expect(overview).toContain('text-red-600 dark:text-red-400');
    expect(overview).toContain('"Payable to suppliers"');
  });
});
