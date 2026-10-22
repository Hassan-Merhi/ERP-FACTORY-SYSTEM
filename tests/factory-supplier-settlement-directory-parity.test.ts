/**
 * Supplier directory card, its summary and the factory Net Position all use
 * the inside Settlement Statement's currency pools: one shared implementation
 * (server/routes/factory/suppliers/balance/settlementPools.ts) and one formula,
 * USD + Σ(native pool × Factory Settings rate). No per-supplier special cases.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { factoryContainers } from "@shared/schema";
import {
  buildSettlementStatementRow,
  computeSettlementCurrencyGroups,
} from "../server/routes/factory/suppliers/balance/settlementPools";
import { supplierUsdEquivalent } from "../server/routes/factory/suppliers/balance/supplierUsdEquivalent";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

type Container = typeof factoryContainers.$inferSelect;
const container = (overrides: Partial<Container>): Container =>
  ({
    id: 1,
    containerNumber: "C1",
    status: "OFFLOADED",
    currencyCode: "EUR",
    totalKg: "0",
    ratePerKg: "0",
    freight: "0",
    freightPaidBy: "supplier",
    freightCurrencyCode: "EUR",
    commissionAmount: "0",
    commissionCurrencyCode: null,
    createdAt: new Date("2026-10-01"),
    ...overrides,
  }) as Container;

const pools = (containers: Container[], fxFromAmount: string) =>
  computeSettlementCurrencyGroups({
    supplierId: 41,
    openingBalance: "0",
    isLinkedSupplier: false,
    statement: containers.map((c) => buildSettlementStatementRow(c, [], false)),
    charges: [],
    payments: [],
    voucherPayments: [],
    fxTransfers: [
      {
        fromSupplierId: 41,
        toSupplierId: 41,
        fromCurrencyCode: "EUR",
        fromAmount: fxFromAmount,
        toAmountUsd: "0",
        sourceType: "supplier",
      },
    ],
  }).map((g) => ({ currencyCode: g.currencyCode, balance: g.netPayable }));

describe("supplier settlement directory parity", () => {
  it("converts the statement pools with USD + Σ(native × configured rate)", () => {
    const equivalent = supplierUsdEquivalent(
      [
        { currencyCode: "USD", balance: "100.00" },
        { currencyCode: "EUR", balance: "42430.40" },
        { currencyCode: "AUD", balance: "-1000.00" },
      ],
      { EUR: 1.18, AUD: 0.65 }
    );
    expect(equivalent.usdEquivalentBalance).toBe((100 + 42430.4 * 1.18 - 650).toFixed(2));
    expect(supplierUsdEquivalent([{ currencyCode: "GBP", balance: "5" }], {}).usdEquivalentBalance).toBeNull();
  });

  it("drops OTW containers from the pool when the loader excludes them", () => {
    const offloaded = container({ id: 1, totalKg: "100000", ratePerKg: "0.5" });
    const otw = container({ id: 2, status: "IN_TRANSIT", totalKg: "10000", ratePerKg: "0.5", freight: "300" });
    const withOtw = pools([offloaded, otw], "20000");
    const withoutOtw = pools([offloaded], "20000");
    expect(withOtw).toEqual([{ currencyCode: "EUR", balance: "35300.00" }]);
    expect(withoutOtw).toEqual([{ currencyCode: "EUR", balance: "30000.00" }]);
    expect(supplierUsdEquivalent(withoutOtw, { EUR: 1.18 }).usdEquivalentBalance).toBe("35400.00");
  });

  it("uses one rule for every supplier card and the Net Position", () => {
    const route = read("server/routes/factory/suppliers/balance/with-balances.ts");
    const statement = read("server/routes/factory/suppliers/supplierStatementRoutes.ts");
    const directory = read("client/src/pages/factory/factory-suppliers/FactorySuppliersDirectory.tsx");
    const netPosition = read("server/routes/factory/employee-pos/netPositionSupplierBalances.ts");
    expect(statement).toContain("computeSettlementCurrencyGroups({");
    expect(route).toContain("loadSupplierSettlementBalances(companyId, { includeOtw, configuredFxRates })");
    expect(netPosition).toContain("includeOtw: true,");
    expect(netPosition).toContain(
      "buildBrokerStatement(s.id, ctx.companyId, true, { asOf: ctx.asOf, knownAt: ctx.knownAt })"
    );
    // No supplier-specific branches remain on the card or the route.
    expect(directory).not.toMatch(/supplier\.id === \d+/);
    expect(route).not.toMatch(/s\.id === \d+/);
    // We owe them → red negative; they owe us → green.
    expect(directory).toContain('`${usdEquivalent > 0 ? "-" : ""}$');
    expect(directory).toContain('"text-red-600 dark:text-red-400"');
  });
});
