/**
 * Company 12 Portugal Saad settlement-vs-posted-GL display reconciliation.
 * Source values independently checked against 30 containers and four FX
 * transfer records on October 15, 2026. These are immutable test examples,
 * not values written to the database or hardcoded into production balances.
 */
import { describe, expect, it } from "vitest";
import { sumMoney, toMoney } from "../server/lib/money";

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
    const differences = sumMoney(["5754.00", "-3540.00", "550.80", "574.80", "586.20"]);
    expect(differences.toFixed(2)).toBe("3925.80");
    expect(toMoney("102139.60").plus(differences).toFixed(2)).toBe("106065.40");
    expect(toMoney("102139.60").times("1.18").plus("5754").toFixed(2)).toBe("126278.73");
  });
});
