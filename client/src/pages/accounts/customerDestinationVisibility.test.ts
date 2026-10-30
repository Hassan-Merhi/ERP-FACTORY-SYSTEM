import { describe, expect, it } from "vitest";
import { shouldShowFactoryCustomerDestination } from "./customerDestinationVisibility";

const visible = (overrides: Partial<Parameters<typeof shouldShowFactoryCustomerDestination>[0]> = {}) =>
  shouldShowFactoryCustomerDestination({
    appMode: "factory",
    accountType: "ledger",
    statementCustomerId: null,
    destinations: [],
    ...overrides,
  });

describe("Factory customer account destination visibility", () => {
  it("shows the column and filter for customer-linked ledger #845 even if type is ledger", () => {
    expect(visible({ statementCustomerId: 23 })).toBe(true);
  });

  it("continues showing destination when a cache snapshot is missing but rows include it", () => {
    expect(visible({ destinations: ["L'SHI", "MALI", null] })).toBe(true);
  });

  it("shows customer statements even before rows load", () => {
    expect(visible({ accountType: "customer" })).toBe(true);
  });

  it("never shows it for regular ledgers or suppliers without customer destination data", () => {
    expect(visible()).toBe(false);
    expect(visible({ accountType: "supplier" })).toBe(false);
  });

  it("does not leak customer-only destination UI into ERP mode", () => {
    expect(visible({ appMode: "erp", statementCustomerId: 23, destinations: ["MALI"] })).toBe(false);
  });
});
