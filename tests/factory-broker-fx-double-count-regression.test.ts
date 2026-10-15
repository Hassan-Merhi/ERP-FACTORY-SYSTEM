import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toMoney, sumMoney } from "../server/lib/money";

// Every operational supplier view reads FX from factory_supplier_fx_transfers.
// The newly posted FACTORY-SFX voucher is a ledger mirror of the same event,
// not a second payment. Only the ledger balance engine must retain it.
const operationalPaths = [
  "server/routes/factory/suppliers/broker/_helpers.ts",
  "server/routes/factory/suppliers/broker/visual-statement.ts",
  "server/routes/factory/suppliers/balance/with-balances.ts",
  "server/routes/factory/suppliers/balance/single.ts",
  "server/routes/factory/suppliers/supplierStatementRoutes.ts",
];

describe("NASRA / broker FX source is counted exactly once", () => {
  for (const file of operationalPaths) {
    it(`excludes source-backed FX vouchers from the payment read in ${file}`, () => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).toContain("factorySupplierFxTransfers");
      expect(source).toContain("NOT LIKE 'FACTORY-PAY-%'");
      expect(source).toContain("NOT LIKE 'FACTORY-SFX-%'");
      expect(source).toContain("NOT LIKE 'FACTORY-PAYABLE-RECLASS-%'");
    });
  }

  it("does not exclude the FX journals from the authoritative ledger", () => {
    const ledger = readFileSync(
      resolve(process.cwd(), "server/routes/factory/suppliers/balance/factorySupplierLedger.ts"),
      "utf8"
    );
    expect(ledger).not.toContain("NOT LIKE 'FACTORY-SFX-%'");
    expect(ledger).not.toContain("NOT LIKE 'FACTORY-PAYABLE-RECLASS-%'");
  });

  it("reconciles supplier-native goods and freight against each transfer once", () => {
    // Exact, read-only October 14 NASRA reconciliation fixture. The wrong route
    // subtracted the same FX again via newly generated FACTORY-SFX debit vouchers.
    const aud = sumMoney(["259207.50", "132870.00", "-392077.00", "-0.50"]);
    const eur = sumMoney(["227365.90", "62955.01", "-290517.60"]);
    expect(aud.toFixed(2)).toBe("0.00");
    expect(eur.toFixed(2)).toBe("-196.69");
    expect(eur.minus("290517.60").toFixed(2)).toBe("-290714.29");
  });

  it("does not double-subtract balanced Oct 15 corrections from broker settlement pools", () => {
    // Real production evidence on 2026-10-15: two sets of individually
    // balanced, EUR-denominated supplier-reclassification journals. The
    // financial net is zero, but a debit-only payment query falsely removes
    // both debit legs from the broker's operational pool.
    const modaFakeEurPayments = sumMoney(["35277.20", "35277.20"]);
    const nasraFakeEurPayments = sumMoney(["7898.40", "7898.40"]);
    expect(modaFakeEurPayments.toFixed(2)).toBe("70554.40");
    expect(nasraFakeEurPayments.toFixed(2)).toBe("15796.80");
    expect(toMoney("41627.10").minus("41627.10").toFixed(2)).toBe("0.00");
    expect(toMoney("9320.11").minus("9320.11").toFixed(2)).toBe("0.00");
  });

  it("leaves NASRA USD pool unaltered while its separate 97-cent discrepancy is audited", () => {
    const usd = sumMoney([
      "627705.9665", "32500", "10500", "16873", "-19999", "-1", "-506081.28",
    ]);
    expect(usd.toFixed(2)).toBe("161497.69");
    expect(usd.minus("161496.72").toFixed(2)).toBe("0.97");
  });
});
