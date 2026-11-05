import { describe, expect, it } from "vitest";
import type { ParsedContainerPreview } from "../server/routes/import/poImportExcelParser";
import { createContainerImportPlan } from "../server/services/intercompany/containerImportPlan";

const sample = (): ParsedContainerPreview => ({
  containerNumber: "MSCU-001",
  supplierCode: "EUROGULF",
  itemsCount: 2,
  posCount: 2,
  itemsTotal: 10000,
  charges: { freight: 400, surcharge: 100, fumigation: 0, documentCharges: 0, discount: 50 },
  chargesTotal: 450,
  grandTotal: 10450,
  pos: ["EURO-100", "EURO-101"],
  items: [
    {
      rowNum: 2,
      poNumber: "EURO-100",
      containerNumber: "MSCU-001",
      supplierCode: "EUROGULF",
      barcode: "A",
      stockItemId: 11,
      itemName: "Grade A",
      quantity: 20,
      rate: 200,
      lineTotal: 4000,
      currency: "USD",
      freight: 0,
      surcharge: 0,
      fumigation: 0,
      discount: 0,
      documentCharges: 0,
    },
    {
      rowNum: 3,
      poNumber: "EURO-101",
      containerNumber: "MSCU-001",
      supplierCode: "EUROGULF",
      barcode: "B",
      stockItemId: 12,
      itemName: "Grade B",
      quantity: 30,
      rate: 200,
      lineTotal: 6000,
      currency: "USD",
      freight: 0,
      surcharge: 0,
      fumigation: 0,
      discount: 0,
      documentCharges: 0,
    },
  ],
});

describe("intercompany Phase 2 landed cost and preserved supplier PO groups", () => {
  it("preserves both original Eurogulf PO groups, excluding unconfirmed estimates", () => {
    const plan = createContainerImportPlan(sample(), {
      containerNumber: "MSCU-001",
      relationshipId: 5,
      chargesConfirmed: false,
    });
    expect(plan.sourcePos.map((po) => po.originalPoNumber)).toEqual(["EURO-100", "EURO-101"]);
    expect(plan.landedTotal).toBe("10000.00");
    expect(plan.charges.freight).toBe("0.00");
    expect(plan.chargesConfirmed).toBe(false);
    expect(plan.sourcePos.map((po) => po.grandTotal)).toEqual(["4000.00", "6000.00"]);
  });

  it("allocates confirmed freight and discount exactly, preserving zero markup", () => {
    const plan = createContainerImportPlan(sample(), {
      containerNumber: "MSCU-001",
      relationshipId: 5,
      chargesConfirmed: true,
      chargeEvidenceReference: "EUROGULF-FREIGHT-INV-2026",
    });
    expect(plan.landedTotal).toBe("10450.00");
    expect(plan.chargesNet).toBe("450.00");
    expect(plan.sourcePos.map((po) => po.grandTotal)).toEqual(["4180.00", "6270.00"]);
    expect(plan.sourcePos.map((po) => po.freight)).toEqual(["160.00", "240.00"]);
    expect(plan.sourcePos.map((po) => po.discount)).toEqual(["20.00", "30.00"]);
    for (const po of plan.sourcePos) {
      expect(Number(po.supplierCredit) + Number(po.chargeAccrualCredit)).toBe(Number(po.grandTotal));
    }
  });

  it("requires charge evidence before marking proposed charges confirmed", () => {
    expect(() =>
      createContainerImportPlan(sample(), {
        containerNumber: "MSCU-001",
        relationshipId: 2,
        chargesConfirmed: true,
      })
    ).toThrow(/evidence|reference/i);
  });

  it("rejects price tampering and non-USD invoices before any transaction", () => {
    const wrong = sample();
    wrong.items[0].lineTotal = 5000;
    expect(() =>
      createContainerImportPlan(wrong, {
        containerNumber: "MSCU-001",
        relationshipId: 2,
        chargesConfirmed: false,
      })
    ).toThrow(/invalid quantity|extended price/i);
    const fx = sample();
    fx.items[0].currency = "ZMW";
    expect(() =>
      createContainerImportPlan(fx, {
        containerNumber: "MSCU-001",
        relationshipId: 2,
        chargesConfirmed: false,
      })
    ).toThrow(/USD invoices only/);
  });

  it("rejects unselected destinations, negative charges and invalid source totals", () => {
    expect(() =>
      createContainerImportPlan(sample(), {
        containerNumber: "MSCU-001",
        relationshipId: 0,
        chargesConfirmed: false,
      })
    ).toThrow(/destination/);
    const bad = sample();
    bad.charges.freight = -1;
    expect(() =>
      createContainerImportPlan(bad, {
        containerNumber: "MSCU-001",
        relationshipId: 2,
        chargesConfirmed: false,
      })
    ).toThrow(/Freight/);
    const totals = sample();
    totals.itemsTotal = 10001;
    expect(() =>
      createContainerImportPlan(totals, {
        containerNumber: "MSCU-001",
        relationshipId: 2,
        chargesConfirmed: false,
      })
    ).toThrow(/reconcile/);
  });
});
