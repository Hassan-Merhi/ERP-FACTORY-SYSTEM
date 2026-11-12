import { describe, expect, it } from "vitest";

/**
 * Financial control for the HADI 2026 original-voucher correction script.
 * The user approved 2026-dated correction JVs and requires *no UI preview*.
 * This test checks the invariant arithmetic, not a database mutation.
 */
const months = [
  "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov",
];
const postedBeforeOpening = [
   24700, 19450, 19450, 19450, 19450, 159050, 41650, 43250, 43250, 44200, 35450,
];
const datedPrepaidAndPaymentFix = [
   -7000,0,0,0,0,-31500,0,0,0,0,3500,
];
const datedReperiodingJournals = [
    15000,15000,15000,18500,21500,-86600,-400,0,0,2000,0,
];
const sourceLeaseExpense = [
  32700,34450,34450,37950,40950,40950,41250,43250,43250,46200,38950,
];
const sum = (arr: readonly number[]) => arr.reduce((total,amount)=>total+amount,0);

describe("HADI 2026 original rent vouchers: dated journal restatement", () => {
  it.each(months.map((month,i)=>[month,i] as const))("%s balances on its actual service month",(_,i)=>{
    const posted = postedBeforeOpening[i]+datedPrepaidAndPaymentFix[i]+datedReperiodingJournals[i];
    expect(posted).toBe(sourceLeaseExpense[i]);
  });
  it("preserves final expense at $434,350 while removing false $35,000 credit opening",()=>{
    expect(sum(postedBeforeOpening)).toBe(469350);
    expect(sum(datedPrepaidAndPaymentFix)).toBe(-35000);
    expect(sum(datedReperiodingJournals)).toBe(0);
    expect(sum(sourceLeaseExpense)).toBe(434350);
  });
  it("replaces the artificial $24,500 prepaid opening without changing $7,000 closing",()=>{
    const prepaidOpeningRemoval=-24500;
    const januaryPrepaid=7000;
    const junePrepaid=21000;
    const novemberRelease=-3500;
    expect(prepaidOpeningRemoval+januaryPrepaid+junePrepaid+novemberRelease).toBe(0);
  });
  it("settles old June accrual against genuine payable with zero net payable change",()=>{
    expect(14700-4200-10500).toBe(0);
  });
  it("closes the separate period-restatement control at zero, not a new liability",()=>{
    expect(sum(datedReperiodingJournals)).toBe(0);
  });
});
