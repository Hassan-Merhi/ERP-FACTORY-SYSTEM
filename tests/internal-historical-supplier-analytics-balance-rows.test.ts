import { describe, expect, it } from "vitest";
import { isInternalHistoricalSupplierRoutineRow } from "../shared/internalHistoricalSupplierRoutineRow";

describe("Analytics and Balances internal historical supplier routine row hiding", () => {
  const goods = {
    companyId: 12,
    voucherNumber: "FACTORY-IMPORT-115-1",
    voucherDescription: "Goods import - container ABCU1234567 (historical supplier reconciliation)",
    createdAt: "2026-10-14T11:20:00.000Z",
  };

  it("hides the exact historical goods and Oct-14 commission voucher identities", () => {
    expect(isInternalHistoricalSupplierRoutineRow(goods)).toBe(true);
    expect(
      isInternalHistoricalSupplierRoutineRow({
        ...goods,
        voucherNumber: "FACTORY-COMM-83-1",
        voucherDescription: "Factory commission",
      })
    ).toBe(true);
    expect(
      isInternalHistoricalSupplierRoutineRow({
        ...goods,
        voucherNumber: "FACTORY-COMM-83",
        voucherDescription: null,
        createdAt: new Date("2026-10-14T10:00:00Z"),
      })
    ).toBe(true);
  });

  it("never hides other company, current commission, or nonhistorical imports", () => {
    expect(isInternalHistoricalSupplierRoutineRow({ ...goods, companyId: 11 })).toBe(false);
    expect(isInternalHistoricalSupplierRoutineRow({ ...goods, companyId: null })).toBe(false);
    expect(
      isInternalHistoricalSupplierRoutineRow({
        ...goods,
        voucherNumber: "FACTORY-IMPORT-115-1",
        voucherDescription: "Goods import - container ABCU1234567",
      })
    ).toBe(false);
    expect(
      isInternalHistoricalSupplierRoutineRow({
        ...goods,
        voucherNumber: "FACTORY-COMM-83-1",
        createdAt: "2026-10-15T12:00:00Z",
      })
    ).toBe(false);
    expect(
      isInternalHistoricalSupplierRoutineRow({
        ...goods,
        voucherNumber: "FACTORY-COMM-83-1",
        createdAt: null,
      })
    ).toBe(false);
    expect(
      isInternalHistoricalSupplierRoutineRow({
        ...goods,
        voucherNumber: "FACTORY-POC-83-64-1",
      })
    ).toBe(false);
  });

  it("hiding table rows never changes the running or ending ledger total", () => {
    const opening = 150;
    const ledger = [
      { ...goods, debit: 200, credit: 0 },
      { ...goods, voucherNumber: "PAY-206", voucherDescription: "Payment", debit: 0, credit: 25 },
      { ...goods, voucherNumber: "FACTORY-COMM-83-1", debit: 80, credit: 0 },
      { ...goods, voucherNumber: "INV-888", debit: 0, credit: 40 },
    ];
    let balance = opening;
    const fullyCalculated = ledger.map((row) => {
      balance += row.credit - row.debit;
      return { ...row, runningBalance: balance };
    });
    const visible = fullyCalculated.filter((row) => !isInternalHistoricalSupplierRoutineRow(row));
    expect(visible.map((row) => row.voucherNumber)).toEqual(["PAY-206", "INV-888"]);
    // 150 opening − 200 + 25 = −25 after PAY-206; − 80 + 40 = −65 after INV-888.
    // The hidden rows still count, so the visible running balances are unchanged.
    expect(visible.map((row) => row.runningBalance)).toEqual([-25, -65]);
    expect(fullyCalculated[fullyCalculated.length - 1].runningBalance).toBe(-65);
    expect(ledger.reduce((sum, row) => sum + row.debit, 0)).toBe(280);
    expect(ledger.reduce((sum, row) => sum + row.credit, 0)).toBe(65);
  });
});
