import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toMoney, sumMoney } from "../server/lib/money";
import { REVIEWED_IMPORT_PAYABLES } from "../scripts/reclassify-factory-import-payables-20261015";
import { buildFactoryVoucherRequest } from "../server/services/factory/factoryVoucherPosting";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

describe("ABO JABER: zero balance by source-verified attribution, not by masking it", () => {
  const jaber = REVIEWED_IMPORT_PAYABLES.filter((x) => x.originalSupplier === 42);

  it("only 9 July import vouchers are incorrectly credited to ABO JABER", () => {
    expect(jaber).toHaveLength(9);
    expect(jaber.map((x) => x.container).sort((a, b) => a - b)).toEqual([153, 154, 155, 156, 157, 158, 159, 160, 161]);
    expect(jaber.every((x) => [47, 48, 49].includes(x.currentSupplier))).toBe(true);
    expect(sumMoney(jaber.map((x) => x.eur)).toFixed(2)).toBe("41126.50");
    expect(sumMoney(jaber.map((x) => x.usd)).toFixed(2)).toBe("48529.27");
    expect(toMoney("41126.50").times("1.18").toFixed(2)).toBe("48529.27");
  });

  it("credits only the correct Germany, UK and Denmark ZIAD linked suppliers", () => {
    const bySupplier = (supplierId: number) =>
      sumMoney(jaber.filter((x) => x.currentSupplier === supplierId).map((x) => x.eur)).toFixed(2);
    expect(bySupplier(49)).toBe("7652.00");
    expect(bySupplier(48)).toBe("12037.00");
    expect(bySupplier(47)).toBe("21437.50");
  });

  it("produces a balanced EUR voucher and leaves source liabilities untouched", () => {
    const row = jaber.find((x) => x.container === 153)!;
    const request = buildFactoryVoucherRequest({
      companyId: 12,
      voucherType: "Journal",
      voucherNumber: "FACTORY-PAYABLE-RECLASS-JABER-20261015-153",
      voucherDate: "2026-10-15",
      description: "Move original erroneous payee to goods supplier",
      currency: "EUR",
      fxRateToUsd: "1.18",
      source: { sourceType: "factory-jaber-goods-reassignment", sourceId: "10003:34408" },
      lines: [
        { factorySupplierId: 42, debit: row.eur },
        { factorySupplierId: 49, credit: row.eur },
      ],
    });
    expect(request.entries).toHaveLength(2);
    expect(request.entries[0].factorySupplierId).toBe(42);
    expect(request.entries[1].factorySupplierId).toBe(49);
    expect(toMoney(request.entries[0].transactionDebitAmount).toFixed(2)).toBe("3692.00");
    expect(toMoney(request.entries[1].transactionCreditAmount).toFixed(2)).toBe("3692.00");
    expect(request.entries[0].debitAmount).toBe(request.entries[1].creditAmount);
    expect(toMoney(request.entries[0].debitAmount).toFixed(2)).toBe("4356.56");
  });

  it("excludes reallocation journal debits from operational broker payment extraction", () => {
    const s = readModuleFamily(resolve(process.cwd(), "server/routes/factory/suppliers/broker/_helpers.ts"));
    const s2 = readModuleFamily(resolve(process.cwd(), "server/routes/factory/suppliers/balance/with-balances.ts"));
    expect(s).toContain("NOT LIKE 'FACTORY-PAYABLE-RECLASS-%'");
    expect(s2).toContain("NOT LIKE 'FACTORY-PAYABLE-RECLASS-%'");
    const correction = readModuleFamily(
      resolve(process.cwd(), "scripts/repair-abo-jaber-supplier-attribution-20261015.ts")
    );
    expect(correction).toContain('const FAMILY = "FACTORY-PAYABLE-RECLASS-JABER-20261015-"');
  });

  it("removes only the redundant top panel, keeping the underlying statement ledger", () => {
    const s = readModuleFamily(
      resolve(process.cwd(), "client/src/pages/factory/factory-suppliers/SupplierStatement.tsx")
    );
    expect(s).not.toContain("import { LedgerBalancePanel }");
    expect(s).not.toContain("<LedgerBalancePanel");
    expect(s).toContain("<SupplierStatementRows");
  });
});
