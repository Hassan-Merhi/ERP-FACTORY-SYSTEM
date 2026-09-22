import { describe, expect, it } from "vitest";
import { resolvePoImportCreditTarget } from "./poImportAccounting";

describe("PO import credit target", () => {
  it("does not let stale settings divert a standalone ERP supplier payable", () => {
    expect(
      resolvePoImportCreditTarget({
        companyType: "erp",
        hasExplicitParentLink: false,
        configuredIntercompanyCreditAccountId: 383,
        supplierId: 71,
      })
    ).toEqual({ kind: "supplier", supplierId: 71 });
  });

  it("uses the configured intercompany account only for an explicitly linked child", () => {
    expect(
      resolvePoImportCreditTarget({
        companyType: "erp",
        hasExplicitParentLink: true,
        configuredIntercompanyCreditAccountId: 383,
        supplierId: 71,
      })
    ).toEqual({ kind: "intercompany", ledgerAccountId: 383 });
  });

  it("keeps supplier credits for standalone ERP companies with no configured account", () => {
    expect(
      resolvePoImportCreditTarget({
        companyType: "erp",
        configuredIntercompanyCreditAccountId: null,
        supplierId: 71,
      })
    ).toEqual({ kind: "supplier", supplierId: 71 });
  });

  it("keeps supplier-partner credits on the supplier-partner path", () => {
    expect(
      resolvePoImportCreditTarget({
        companyType: "supplier_partner",
        hasExplicitParentLink: true,
        configuredIntercompanyCreditAccountId: 383,
        supplierId: 71,
      })
    ).toEqual({ kind: "supplier", supplierId: 71 });
  });
});
