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

describe("Completed worker advance corrections are hidden only after balance calculation", () => {
  const may = {
    companyId: 12,
    voucherId: 17122,
    voucherDate: "2026-05-17",
    voucherNumber: "JV-12-2026-000023",
    voucherDescription: "Historical worker advances GL reconciliation: May 17 paid payroll #672 final cent of advance #131",
    debit: 0,
    credit: 0.01,
  };
  const july = {
    companyId: 12,
    voucherId: 17123,
    voucherDate: new Date("2026-07-10T00:00:00Z"),
    voucherNumber: "JV-12-2026-000024",
    voucherDescription: "Historical worker advances GL reconciliation: July 10 audited unsupported opening excess",
    debit: 0,
    credit: 51.60,
  };
  it("identifies the original vouchers exactly, not unrelated journals or companies", () => {
    expect(isInternalHistoricalSupplierRoutineRow(may)).toBe(true);
    expect(isInternalHistoricalSupplierRoutineRow(july)).toBe(true);
    expect(isInternalHistoricalSupplierRoutineRow({ ...may, companyId: 11 })).toBe(false);
    expect(isInternalHistoricalSupplierRoutineRow({ ...may, voucherId: 17022 })).toBe(false);
    expect(isInternalHistoricalSupplierRoutineRow({ ...may, voucherNumber: "JV-12-2026-000040" })).toBe(false);
    expect(isInternalHistoricalSupplierRoutineRow({ ...july, voucherDate: "2026-11-03" })).toBe(false);
  });
  it("leaves the actual closing balance and all posted credit movements intact", () => {
    const opening = 2726.61;
    const rows = [
      { ...may, credit: 0.01 },
      { ...july, credit: 51.60 },
      { ...may, voucherId: 17130, voucherNumber: "JV-12-2026-000030", credit: 10 },
    ];
    let balance = opening;
    const fullyCalculated = rows.map((v) => {
      balance = Number((balance - v.credit + v.debit).toFixed(2));
      return { ...v, runningBalance: balance };
    });
    const routine = fullyCalculated.filter((v) => !isInternalHistoricalSupplierRoutineRow(v));
    expect(routine.map((v) => v.voucherId)).toEqual([17130]);
    expect(routine[0].runningBalance).toBe(2665);
    expect(balance).toBe(2665);
    expect(rows.reduce((sum, v) => sum + v.credit, 0)).toBeCloseTo(61.61, 2);
  });
});
