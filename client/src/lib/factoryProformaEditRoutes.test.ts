import { describe, it, expect } from "vitest";
import { invoicingProformaEditPath, invoicingProformaReturnPath } from "./factoryProformaEditRoutes";

describe("Invoicing proforma full-page editor navigation", () => {
  it("opens the dedicated Invoicing edit page with the selected customer", () => {
    expect(invoicingProformaEditPath(87, 48))
      .toBe("/factory/invoicing/proformas/87/edit?customerId=48");
  });

  it("supports a proforma without customer query state", () => {
    expect(invoicingProformaEditPath(87, null))
      .toBe("/factory/invoicing/proformas/87/edit");
  });

  it("returns to the same Invoicing customer and expanded proforma after save or cancel", () => {
    expect(invoicingProformaReturnPath(87, "48"))
      .toBe("/factory/invoicing?tab=proformas&customerId=48&expandProformaId=87");
  });

  it("never forwards invalid customer parameters into Invoicing navigation", () => {
    expect(invoicingProformaReturnPath(87, "48&tab=invoices"))
      .toBe("/factory/invoicing?tab=proformas&expandProformaId=87");
    expect(invoicingProformaReturnPath(null, null))
      .toBe("/factory/invoicing?tab=proformas");
  });
});
