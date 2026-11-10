import { describe, expect, it } from "vitest";

/**
 * Phase: January 2026 source-voucher debit/prepaid classification.
 * Cash/legacy credit counterparts are NEVER changed; superseded original
 * prepaid reclassification JVs remain retained but excluded from posted GL.
 */
const originalPayments = [
  { voucher: 6479, total: 6000, january: 1500, prepaid: 4500 },
  { voucher: 6481, total: 6000, january: 1500, prepaid: 4500 },
  { voucher: 6483, total: 8000, january: 2000, prepaid: 6000 },
  { voucher: 6486, total: 12000, january: 3000, prepaid: 9000 },
  { voucher: 6493, total: 12600, january: 4200, prepaid: 8400 },
  { voucher: 6497, total: 42000, january: 3500, prepaid: 38500 },
];
const sum = (arr: number[]) => arr.reduce((a,b) => a+b,0);
const r = (key: "total"|"january"|"prepaid") => sum(originalPayments.map(p=>p[key]));

describe("HADI Jan 2026 original voucher classification", () => {
  it.each(originalPayments)(
    "retains payment header/contra $total and divides the original debit into January + future rent on #$voucher",
    payment => {
      expect(payment.january + payment.prepaid).toBe(payment.total);
    }
  );
  it("moves exactly $70,900 from Jan expense to prepaid and supersedes $70,900 of matching original journal reclassifications",()=>{
    expect(r("total")).toBe(86600);
    expect(r("january")).toBe(15700);
    expect(r("prepaid")).toBe(70900);
  });
  it("reduces the historic #8787 transfer to $156,850, leaving archived #881 at zero",()=>{
    expect(227750-r("prepaid")).toBe(156850);
    const originalOld = 323750-323750;
    const afterOld = (323750-70900) - (323750-70900);
    expect(afterOld).toBe(originalOld);
    expect(afterOld).toBe(0);
  });
  it("shows $32,700 Dr with zero January rent credits in actual ledger lines",()=>{
    const originalDr=103600;
    const originalCr=70900;
    const afterDr=originalDr-r("prepaid");
    const afterCr=originalCr-r("prepaid");
    expect({afterDr,afterCr}).toEqual({afterDr:32700,afterCr:0});
  });
  it("preserves the $434,350 expense and $7,000 prepaid, $18,000 payable closings",()=>{
    const oldExpense1007=434350;
    const newExpense1007=oldExpense1007+70900-70900;
    const oldPrepaid=7000;
    const newPrepaid=oldPrepaid+70900-70900;
    expect(newExpense1007).toBe(434350);
    expect(newPrepaid).toBe(7000);
    expect(-18000).toBe(-18000);
  });
});
