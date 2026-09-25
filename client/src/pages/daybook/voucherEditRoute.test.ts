import { describe, expect, it } from "vitest";
import { voucherEditPath } from "./voucherEditRoute";

describe("voucherEditPath", () => {
  it("opens the matching Vouchers tab in edit mode", () => {
    expect(voucherEditPath({ id: 7, voucherType: "Journal" })).toBe("/vouchers?edit=7&tab=journal&from=daybook");
    expect(voucherEditPath({ id: 8, voucherType: "Stock Transfer" })).toBe(
      "/vouchers?edit=8&tab=transferorder&from=daybook"
    );
    expect(voucherEditPath({ id: 9, voucherType: "Debit Note" }, "/properties/vouchers")).toBe(
      "/properties/vouchers?edit=9&tab=credit-note&from=daybook"
    );
  });

  it("sends Sales/POS to the POS editor and Purchase to its tab", () => {
    expect(voucherEditPath({ id: 3, voucherType: "POS" })).toBe("/pos/edit/3");
    expect(voucherEditPath({ id: 4, voucherType: "Purchase" })).toBe("/vouchers?edit=4&tab=purchase&from=daybook");
  });

  it("returns null for types without an editor", () => {
    expect(voucherEditPath({ id: 5, voucherType: "Opening" })).toBeNull();
  });
});
