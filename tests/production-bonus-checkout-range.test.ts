import { describe, expect, it } from "vitest";
import { parseTargetBonusPaymentCommand } from "../server/services/factory/targetBonusPaymentPolicy";
import { targetBonusValidRange } from "../server/services/factory/targetBonusReview";

const base={
  confirm:true, currency:"USD", paymentDate:"2026-10-31", cashAccountId:41,
};

describe("bonus checkout over a selected production date range",()=>{
  it("accepts a custom October 4–31 range and rejects reversed or oversized ranges",()=>{
    expect(targetBonusValidRange("2026-10-04","2026-10-31")).toBe(true);
    expect(targetBonusValidRange("2026-10-31","2026-10-04")).toBe(false);
    expect(targetBonusValidRange("2026-10-01","2026-11-02")).toBe(false);
    expect(targetBonusValidRange("2026-10-30","2026-10-30")).toBe(true);
  });
  it("allows the same worker to be paid for multiple eligible days as separate claims",()=>{
    const parsed=parseTargetBonusPaymentCommand({...base,selections:[
      {date:"2026-10-29",workerId:8,expectedAmount:"6.00"},
      {date:"2026-10-04",workerId:8,expectedAmount:"5.50"},
      {date:"2026-10-04",workerId:9,expectedAmount:"4.25"},
    ]});
    expect(parsed.selections).toEqual([
      {date:"2026-10-04",workerId:8,expectedAmount:"5.50"},
      {date:"2026-10-04",workerId:9,expectedAmount:"4.25"},
      {date:"2026-10-29",workerId:8,expectedAmount:"6.00"},
    ]);
  });
  it("rejects duplicate worker-day claims and invalid amounts",()=>{
    expect(()=>parseTargetBonusPaymentCommand({...base,selections:[
      {date:"2026-10-04",workerId:8,expectedAmount:"3.00"},
      {date:"2026-10-04",workerId:8,expectedAmount:"3.00"},
    ]})).toThrow(/Duplicate worker\/day/);
    expect(()=>parseTargetBonusPaymentCommand({...base,selections:[
      {date:"2026-10-04",workerId:8,expectedAmount:"0.00"},
    ]})).toThrow();
  });
  it("retains the 100 worker-day limit to protect transactional posting",()=>{
    const selections=Array.from({length:101},(_,i)=>({
      date:"2026-10-04",workerId:i+1,expectedAmount:"1.00",
    }));
    expect(()=>parseTargetBonusPaymentCommand({...base,selections})).toThrow(/between 1 and 100/);
  });
});
