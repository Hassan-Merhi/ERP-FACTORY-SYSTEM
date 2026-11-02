import { describe, expect, it } from "vitest";
import {
  isInternalHistoricalSupplierCatchup,
  operationalHistoricalSupplierExclusionSql,
  type RoutineHistoricalSupplierVoucher,
} from "../server/services/accounting/internalHistoricalSupplierRoutineVisibility";

const original: RoutineHistoricalSupplierVoucher = {
  companyId: 12,
  voucherNumber: "FACTORY-IMPORT-115-1",
  description: "Goods import - container ABCU1234567 (historical supplier reconciliation)",
  createdAt: "2026-10-14 11:20:00",
};

describe("Company-12 historical supplier catchup is an internal posting in routine browsers only", () => {
  it("identifies legacy goods even if they carry a future effective date", () => {
    expect(isInternalHistoricalSupplierCatchup(original)).toBe(true);
  });
  it("identifies exact batch commissions, not later commission processing", () => {
    expect(isInternalHistoricalSupplierCatchup({
      ...original, voucherNumber: "FACTORY-COMM-83",
      description: "Container commission",
    })).toBe(true);
    expect(isInternalHistoricalSupplierCatchup({
      ...original, voucherNumber: "FACTORY-COMM-83-1",
      description: "Container commission",
      createdAt: new Date("2026-10-14T11:20:00Z"),
    })).toBe(true);
    expect(isInternalHistoricalSupplierCatchup({
      ...original, voucherNumber: "FACTORY-COMM-83-1",
      description: "Container commission",
      createdAt: "2026-10-15 00:01:00",
    })).toBe(false);
  });
  it("never hides normal imports, other-company journals or new sales", () => {
    expect(isInternalHistoricalSupplierCatchup({ ...original, companyId: 11 })).toBe(false);
    expect(isInternalHistoricalSupplierCatchup({
      ...original, description: "Goods import - container ABCU1234567",
    })).toBe(false);
    expect(isInternalHistoricalSupplierCatchup({
      ...original, voucherNumber: "FACTORY-COMM-85", createdAt: "2026-11-02 12:00:00",
    })).toBe(false);
    expect(isInternalHistoricalSupplierCatchup({
      ...original, voucherNumber: "FACTORY-POC-83-64-1",
    })).toBe(false);
  });
  it("constrains SQL only to the known company and legacy identity", () => {
    expect(operationalHistoricalSupplierExclusionSql(11,"v")).toBe("TRUE");
    const paginated = operationalHistoricalSupplierExclusionSql(12,"v");
    const other = operationalHistoricalSupplierExclusionSql(12,"vouchers");
    expect(paginated).toContain("COALESCE(v.voucher_number,'') ~ '^FACTORY-IMPORT-");
    expect(paginated).toContain("v.created_at >= TIMESTAMP '2026-10-14'");
    expect(other).toContain("vouchers.description");
    expect(paginated).toMatch(/^NOT \(/);
  });
});
