import {describe,it,expect} from "vitest";
import {latestUnpaidWorkerRate,rateChangeMayRepriceReview} from "./productionBonusUnpaidRatePolicy";

describe("Unpaid production bonus rate changes",()=>{
  const rates=[
    {scope:"worker",workerId:4,rate:"2.0000",enabled:true},
    {scope:"company",workerId:null,rate:"1.5000",enabled:true},
  ];
  it("uses latest saved worker rate for any unpaid week, independent of production date",()=>{
    expect(latestUnpaidWorkerRate(rates,4)).toBe("2.0000");
    expect(latestUnpaidWorkerRate(rates,7)).toBe("1.5000");
    expect(3*Number(latestUnpaidWorkerRate(rates,4))).toBe(6);
    expect(3*Number(latestUnpaidWorkerRate([{scope:"worker",workerId:4,rate:"3.5000",enabled:true},...rates],4))).toBe(10.5);
  });
  it("requires positive enabled rate, preventing payment from stale settings",()=>{
    expect(latestUnpaidWorkerRate([{scope:"worker",workerId:4,enabled:false,rate:"4.00"},...rates],4)).toBeNull();
    expect(latestUnpaidWorkerRate([{scope:"company",workerId:null,enabled:true,rate:"0"}],7)).toBeNull();
  });
  it("reprices approved unpaid claims but not rejected, posted, or reversed claims",()=>{
    expect(rateChangeMayRepriceReview("approved",null)).toBe(true);
    expect(rateChangeMayRepriceReview("approved",undefined)).toBe(true);
    expect(rateChangeMayRepriceReview("approved","POSTED")).toBe(false);
    expect(rateChangeMayRepriceReview("approved","REVERSED")).toBe(false);
    expect(rateChangeMayRepriceReview("rejected",null)).toBe(false);
  });
});
