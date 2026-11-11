import { describe,expect,it } from "vitest";
import {
  inspectDispatchTripPostingSnapshot,
  type DispatchPostingRow,
} from "../server/services/factory/dispatchIntegritySnapshot";

const threeTrips:DispatchPostingRow[]=[
  {status:"POSTED",postingId:"1",goods:"4000.00",billable:"2000.00",discounts:"0.00",total:"6000.00"},
  {status:"POSTED",postingId:"2",goods:"3000.00",billable:"1000.00",discounts:"0.00",total:"4000.00"},
  {status:"POSTED",postingId:"3",goods:"3606.00",billable:"270.15",discounts:"0.00",total:"3876.15"},
];
const unsigned={
  isSigned:false,postingIds:[],goods:"0.00",billable:"0.00",
  discounts:"0.00",total:"0.00",
};
const signed={
  isSigned:true,postingIds:["1","2","3"],goods:"10606.00",
  billable:"3270.15",discounts:"0.00",total:"13876.15",
};
const state=(checks:ReturnType<typeof inspectDispatchTripPostingSnapshot>["checks"],code:string)=>
  checks.find(c=>c.code===code)?.state;

describe("Factory dispatch integrity before and after reconciliation signoff",()=>{
  it("does not compare 3 posted trips with unsigned zero-value consolidation defaults",()=>{
    const audit=inspectDispatchTripPostingSnapshot(threeTrips,unsigned);
    expect(audit.postedCount).toBe(3);
    expect(audit.goods).toBe("10606.00");
    expect(audit.billable).toBe("3270.15");
    expect(audit.discounts).toBe("0.00");
    expect(audit.receivable).toBe("13876.15");
    expect(state(audit.checks,"POSTED_TRIP_IDENTITIES")).toBe("PASS");
    expect(state(audit.checks,"POSTED_TRIP_TOTAL_MATH")).toBe("PASS");
    for(const code of [
      "TRIP_POST_IDENTITIES","SIGNED_TRIP_GOODS",
      "SIGNED_TRIP_CHARGES","SIGNED_TRIP_RECEIVABLE",
    ])expect(state(audit.checks,code)).toBe("NOT_APPLICABLE");
    expect(audit.checks.some(c=>c.state==="BLOCK")).toBe(false);
  });

  it("still validates a genuinely signed reconciliation",()=>{
    const audit=inspectDispatchTripPostingSnapshot(threeTrips,signed);
    for(const code of [
      "TRIP_POST_IDENTITIES","SIGNED_TRIP_GOODS",
      "SIGNED_TRIP_CHARGES","SIGNED_TRIP_RECEIVABLE",
    ])expect(state(audit.checks,code)).toBe("PASS");
  });

  it("blocks the original 4 mismatches when the zero snapshot has actually been signed",()=>{
    const audit=inspectDispatchTripPostingSnapshot(threeTrips,{...unsigned,isSigned:true});
    for(const code of [
      "TRIP_POST_IDENTITIES","SIGNED_TRIP_GOODS",
      "SIGNED_TRIP_CHARGES","SIGNED_TRIP_RECEIVABLE",
    ])expect(state(audit.checks,code)).toBe("BLOCK");
  });

  it("blocks missing and duplicate POST identities even before signoff",()=>{
    for(const bad of [null,"1"]){
      const trips=threeTrips.map((t,i)=>i===2?{...t,postingId:bad}:t);
      const audit=inspectDispatchTripPostingSnapshot(trips,unsigned);
      expect(state(audit.checks,"POSTED_TRIP_IDENTITIES")).toBe("BLOCK");
    }
  });

  it("blocks per-trip arithmetic errors independently of the unsigned combined invoice",()=>{
    const trips=threeTrips.map((t,i)=>i===2?{...t,total:"3877.15"}:t);
    const audit=inspectDispatchTripPostingSnapshot(trips,unsigned);
    expect(state(audit.checks,"POSTED_TRIP_TOTAL_MATH")).toBe("BLOCK");
    expect(state(audit.checks,"SIGNED_TRIP_RECEIVABLE")).toBe("NOT_APPLICABLE");
  });

  it("does not flag a not-yet-posted unsigned loading as a signed mismatch",()=>{
    const audit=inspectDispatchTripPostingSnapshot([],unsigned);
    expect(state(audit.checks,"NO_POSTED_TRIPS")).toBe("INFO");
    expect(audit.checks.every(c=>c.state!=="BLOCK")).toBe(true);
  });
});
