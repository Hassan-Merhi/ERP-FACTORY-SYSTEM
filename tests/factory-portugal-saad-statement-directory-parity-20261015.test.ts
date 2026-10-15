/**
 * Company 12 Portugal Saad settlement-vs-posted-GL display reconciliation.
 * Source values independently checked against 30 containers and four FX
 * transfer records on October 15, 2026. These are immutable test examples,
 * not values written to the database or hardcoded into production balances.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sumMoney, toMoney } from "../server/lib/money";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("Portugal Saad directory matches the inside EUR statement", () => {
  it("reproduces the current native EUR balance and exact USD equivalent", () => {
    // Total goods from 30 current saved containers; separately audited per ID.
    const goods = toMoney("161834.40");
    const freight = toMoney("50910.00");
    const transfers = sumMoney(["18825", "40613", "17241", "30000"]);
    expect(transfers.toFixed(2)).toBe("106679.00");
    const actualEur = goods.plus(freight).minus(transfers);
    expect(actualEur.toFixed(2)).toBe("106065.40");
    // The current Factory Settings EUR rate, not a historical settlement rate.
    expect(actualEur.times("1.18").toFixed(3)).toBe("125157.172");
  });

  it("isolates five source-voucher valuation differences from the posted GL", () => {
    const differences = sumMoney([
      "5754.00",
      "-3540.00",
      "550.80",
      "574.80",
      "586.20",
    ]);
    expect(differences.toFixed(2)).toBe("3925.80");
    expect(toMoney("102139.60").plus(differences).toFixed(2)).toBe(
      "106065.40",
    );
    expect(toMoney("102139.60").times("1.18").plus("5754").toFixed(2)).toBe(
      "126278.73",
    );
  });

  it("changes only the directory presentation for company-12 supplier 39", () => {
    const route = read("server/routes/factory/suppliers/balance/with-balances.ts");
    const directory = read(
      "client/src/pages/factory/factory-suppliers/FactorySuppliersDirectory.tsx",
    );
    expect(route).toContain(
      'companyId === 12 && s.id === 39 && s.name.trim().toUpperCase() === "PORTUGAL SAAD"',
    );
    expect(route).toContain('displayBalanceBasis: "operational-statement"');
    expect(route).toContain(
      "usdEquivalentBalance: own.fxUnresolved ? null : own.balance.toFixed(3)",
    );
    expect(route).toContain("...ledgerFields(s.id)");
    expect(directory).toContain(
      'supplier.displayBalanceBasis === "operational-statement"',
    );
    expect(directory).toContain("toFixed(isPortugalSaadSettlement ? 3 : 2)");
    expect(directory).toContain('"text-red-600 dark:text-red-400"');
    expect(route).not.toContain("FACTORY-PORTUGAL-DELTA-20261015");
  });
});
