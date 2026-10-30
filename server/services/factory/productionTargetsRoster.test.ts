import { describe, expect, it } from "vitest";
import { isProductionTargetsRosterWorker } from "./productionTargetsRoster";

const open={
  finalized:false,savedForPeriod:false,plannerAssigned:true,
  linkedForPeriod:false,active:true,joinedByPeriodEnd:true,
};

describe("Production Targets / Production Bonuses shared worker roster",()=>{
  it("lists current active planner workers, even without a target, bales, or tracking entry",()=>{
    expect(isProductionTargetsRosterWorker(open)).toBe(true);
  });

  it("does not list unrelated factory workers who never appeared in Production Targets",()=>{
    expect(isProductionTargetsRosterWorker({...open,plannerAssigned:false})).toBe(false);
  });

  it("does not list inactive, unlinked, unsaved or not-yet-joined workers",()=>{
    expect(isProductionTargetsRosterWorker({...open,active:false})).toBe(false);
    expect(isProductionTargetsRosterWorker({...open,joinedByPeriodEnd:false})).toBe(false);
  });

  it("keeps inactive workers with saved records or effective links on open days",()=>{
    expect(isProductionTargetsRosterWorker({
      ...open,active:false,savedForPeriod:true,
    })).toBe(true);
    expect(isProductionTargetsRosterWorker({
      ...open,active:false,linkedForPeriod:true,
    })).toBe(true);
  });

  it("uses only that day's saved roster after End Production",()=>{
    expect(isProductionTargetsRosterWorker({
      ...open,finalized:true,savedForPeriod:false,
    })).toBe(false);
    expect(isProductionTargetsRosterWorker({
      ...open,finalized:true,savedForPeriod:true,
      plannerAssigned:false,active:false,
    })).toBe(true);
  });
});
