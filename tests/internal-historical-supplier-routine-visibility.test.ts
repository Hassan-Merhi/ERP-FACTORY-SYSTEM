import { describe, expect, it } from "vitest";
import {
  isInternalHistoricalSupplierCatchup,
  isInternalFactoryAdvanceReconciliation,
  operationalHistoricalSupplierExclusionSql,
  operationalHistoricalSupplierGlobalExclusionSql,
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
  it("scopes global All Daybook catchup exclusions per voucher company", () => {
    const sql = operationalHistoricalSupplierGlobalExclusionSql("v");
    expect(sql).toContain("v.company_id <> 12");
    expect(sql).toContain("FACTORY-IMPORT-[0-9]+");
    expect(sql).toContain("FACTORY-COMM-[0-9]+");
    // A legacy-numbered journal in a different company must remain visible.
    expect(sql).toContain(" OR");
    expect(operationalHistoricalSupplierGlobalExclusionSql("vouchers")).toContain("vouchers.company_id <> 12");
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

describe("two audited worker advance GL corrections are internal, not routine journals", () => {
  const may = {
    companyId: 12,
    id: 17122,
    voucherNumber: "JV-12-2026-000023",
    voucherDate: "2026-05-17",
    description: "Historical worker advances GL reconciliation: May 17 paid payroll #672 final cent of advance #131",
  };
  const july = {
    companyId: 12,
    id: 17123,
    voucherNumber: "JV-12-2026-000024",
    voucherDate: new Date("2026-07-10T00:00:00Z"),
    description: "Historical worker advances GL reconciliation: July 10 audited unsupported opening excess",
  };

  it("recognizes exactly the two verified, already-posted company-12 vouchers", () => {
    expect(isInternalFactoryAdvanceReconciliation(may)).toBe(true);
    expect(isInternalFactoryAdvanceReconciliation(july)).toBe(true);
  });
  it("preserves other companies and any changed/future voucher identities", () => {
    expect(isInternalFactoryAdvanceReconciliation({ ...may, companyId: 11 })).toBe(false);
    expect(isInternalFactoryAdvanceReconciliation({ ...may, id: 17124 })).toBe(false);
    expect(isInternalFactoryAdvanceReconciliation({ ...may, voucherNumber: "JV-12-2026-000030" })).toBe(false);
    expect(isInternalFactoryAdvanceReconciliation({ ...may, voucherDate: "2026-11-03" })).toBe(false);
    expect(isInternalFactoryAdvanceReconciliation({ ...may, description: "A normal advance payment" })).toBe(false);
    expect(isInternalFactoryAdvanceReconciliation({ ...july, id: 17223 })).toBe(false);
  });
  it("uses the same exact signatures before SQL pagination, counts, and global grouping", () => {
    const paginated = operationalHistoricalSupplierExclusionSql(12, "vouchers");
    expect(paginated).toContain("vouchers.id = 17122");
    expect(paginated).toContain("vouchers.id = 17123");
    expect(paginated).toContain("vouchers.voucher_number = 'JV-12-2026-000023'");
    expect(paginated).toContain("vouchers.voucher_date = DATE '2026-07-10'");
    expect(operationalHistoricalSupplierExclusionSql(11, "v")).toBe("TRUE");
    const global = operationalHistoricalSupplierGlobalExclusionSql("v");
    expect(global).toContain("v.company_id <> 12");
    expect(global).toContain("v.id = 17122");
    expect(global).toContain("v.id = 17123");
  });
});
