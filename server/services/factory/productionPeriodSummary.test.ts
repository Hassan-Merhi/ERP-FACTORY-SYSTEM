import {describe,expect,it} from "vitest";
import {aggregateProductionPeriodDays,type PeriodTargetDay} from "./productionPeriodSummary";

const day=(date:string,workerId:number,target:number|null,status:PeriodTargetDay["status"]="Present",
  category="Bags"):PeriodTargetDay=>({date,workerId,target,status,category});

describe("weekly and monthly Production Targets rollup",()=>{
  it("adds daily targets across a week and does not treat all produced as extra",()=>{
    const summary=aggregateProductionPeriodDays([
      day("2026-10-26",7,10),day("2026-10-27",7,10),
      day("2026-10-28",7,10),day("2026-10-29",7,10),
      day("2026-10-30",7,10),day("2026-10-31",7,10),
      day("2026-11-01",7,10),
    ],[{date:"2026-10-26",workerId:7,producedBales:12},
       {date:"2026-10-27",workerId:7,producedBales:10}]);
    const worker=summary.get(7)!;
    expect(worker.targetBales).toBe(70);
    expect(worker.producedBales).toBe(22);
    expect(worker.producedBales-worker.targetBales!).toBe(-48);
  });

  it("honors midweek changed targets and subtracts only the absent day's target",()=>{
    const summary=aggregateProductionPeriodDays([
      day("2026-10-26",2,10),day("2026-10-27",2,12,"Absent"),
      day("2026-10-28",2,14,"Present","Shoes"),
    ],[{date:"2026-10-26",workerId:2,producedBales:9},
      {date:"2026-10-28",workerId:2,producedBales:18}]);
    expect(summary.get(2)).toMatchObject({
      targetBales:36,absentTargetBales:12,producedBales:27,
      category:"Shoes",days:3,absentDays:1,status:"Present",
    });
    expect(27-(36-12)).toBe(3);
  });

  it("counts linked-worker shares once, not the whole team for each member",()=>{
    const summary=aggregateProductionPeriodDays([
      day("2026-10-26",3,10),day("2026-10-26",4,10),
    ],[{date:"2026-10-26",workerId:3,producedBales:7},
      {date:"2026-10-26",workerId:4,producedBales:7}]);
    expect([...summary.values()].reduce((n,row)=>n+row.producedBales,0)).toBe(14);
    expect([...summary.values()].reduce((n,row)=>n+(row.targetBales??0),0)).toBe(20);
  });

  it("preserves unset targets as missing rather than silently manufacturing a daily target",()=>{
    const summary=aggregateProductionPeriodDays([
      day("2026-10-26",9,null),day("2026-10-27",9,null),
    ],[{date:"2026-10-26",workerId:9,producedBales:3}]);
    expect(summary.get(9)).toMatchObject({targetBales:null,producedBales:3,days:2,missingTargetDays:2});
  });

  it("marks an incomplete custom period without treating zero targets as missing",()=>{
    const summary=aggregateProductionPeriodDays([
      day("2026-10-27",4,8),
      day("2026-10-28",4,null),
      day("2026-10-29",4,0,"Absent"),
    ],[
      {date:"2026-10-27",workerId:4,producedBales:9},
      {date:"2026-10-28",workerId:4,producedBales:6},
    ]);
    expect(summary.get(4)).toMatchObject({
      targetBales:8,absentTargetBales:0,producedBales:15,
      missingTargetDays:1,absentDays:1,days:3,
    });
  });

  it("separates months and workers in the given day range",()=>{
    const summary=aggregateProductionPeriodDays([
      day("2026-10-30",1,8),day("2026-10-31",1,9),
      day("2026-10-30",2,7),
    ],[{date:"2026-10-30",workerId:1,producedBales:12},
      {date:"2026-10-30",workerId:2,producedBales:7}]);
    expect(summary.get(1)).toMatchObject({targetBales:17,producedBales:12});
    expect(summary.get(2)).toMatchObject({targetBales:7,producedBales:7});
  });
});
