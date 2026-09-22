import { describe, expect, it } from "vitest";
import {
  classifyPoSupplierPosting,
  expectedPoSupplierPayable,
  parentImportVoucherNumberPattern,
} from "./poSupplierReconciliation";

describe("PO supplier reconciliation", () => {
  const po = {
    itemsTotal: "1000",
    freight: "100",
    surcharge: "20",
    fumigation: "5",
    documentCharges: "10",
    discount: "15",
    otherCharges: "2",
    isSubsidiary: true,
  };

  it("includes supplier-paid charges in the payable", () => {
    expect(expectedPoSupplierPayable({ ...po, freightPaidBy: "supplier" }).toFixed(2)).toBe("1122.00");
  });

  it("excludes parent-paid freight from the supplier payable", () => {
    expect(expectedPoSupplierPayable({ ...po, freightPaidBy: "parent" }).toFixed(2)).toBe("1022.00");
  });

  it("excludes own-paid freight from the supplier payable", () => {
    expect(expectedPoSupplierPayable({ ...po, freightPaidBy: "own" }).toFixed(2)).toBe("1022.00");
  });

  it("detects missing, stale and duplicate postings", () => {
    const expected = expectedPoSupplierPayable({ ...po, freightPaidBy: "parent" });
    expect(classifyPoSupplierPosting(expected, []).status).toBe("missing");
    expect(classifyPoSupplierPosting(expected, ["1000"]).status).toBe("amount_mismatch");
    expect(classifyPoSupplierPosting(expected, ["1022", "1022"]).status).toBe("duplicate");
    expect(classifyPoSupplierPosting(expected, ["1022"]).status).toBe("matched");
  });

  it("matches the real parent import voucher format", () => {
    expect(parentImportVoucherNumberPattern(7, "PO-42")).toBe("IC-7-PO-42-%");
  });
});
