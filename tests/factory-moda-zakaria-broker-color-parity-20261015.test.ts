import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toMoney } from "../server/lib/money";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("MODA ZAKARIA broker settlement sign and color parity", () => {
  it("preserves the USD pool penny in the current equivalent", () => {
    const eurPayable = toMoney("27932.85");
    const usdPool = toMoney("-0.01");
    const usdRate = toMoney("1.18");
    expect(eurPayable.times(usdRate).toFixed(3)).toBe("32960.763");
    expect(eurPayable.times(usdRate).plus(usdPool).toFixed(3)).toBe(
      "32960.753",
    );
    expect(eurPayable.times(usdRate).plus(usdPool).toFixed(2)).toBe(
      "32960.75",
    );
  });

  it("shows positive payable red on the broker directory and overview", () => {
    const directory = read(
      "client/src/pages/factory/factory-suppliers/FactorySuppliersDirectory.tsx",
    );
    const overview = read(
      "client/src/pages/factory/factory-suppliers/BrokerOverviewPanel.tsx",
    );
    expect(directory).toContain("supplier.id === 37");
    expect(directory).toContain('"MODA ZAKARIA DIRECT"');
    expect(directory).toContain("usdEquivalent > 0.005");
    expect(directory).toContain('"text-red-600 dark:text-red-400"');
    expect(overview).toContain('data-testid="text-broker-usd-equivalent"');
    expect(overview).toContain(
      "Number(parentSup.usdEquivalentBalance ?? 0) > 0.005",
    );
  });

  it("uses red for EUR payable but keeps USD broker asset conventions", () => {
    const directory = read(
      "client/src/pages/factory/factory-suppliers/FactorySuppliersDirectory.tsx",
    );
    const overview = read(
      "client/src/pages/factory/factory-suppliers/BrokerOverviewPanel.tsx",
    );
    expect(directory).toContain('data-testid="text-moda-eur-net-balance"');
    expect(directory).toContain('pool.currencyCode === "EUR" && !pool.isBrokerPool');
    expect(directory).toContain('modaEuroBalance > 0 ? " payable" : " overpaid"');
    expect(overview).toContain("b.isBrokerPool");
    expect(overview).toContain('"Payable to suppliers"');
    expect(overview).toContain('"text-green-600 dark:text-green-400"');
    expect(overview).toContain('"text-red-600 dark:text-red-400"');
  });
});
