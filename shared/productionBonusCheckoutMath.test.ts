import {describe,expect,it} from "vitest";
import {allocateWeeklyExtraBales,splitExtraBalesByCategory,workerCategoryCredits,linkedWorkerBaleShares} from "./productionBonusCheckoutMath";

describe("Production Targets bonus category allocation",()=>{
  it("credits 14 linked bales exactly once, seven to each worker",()=>{
    const bales=Array.from({length:14},(_,i)=>({
      id:i+1,worker:i%2?10:11,category:"Bags",
    }));
    const first=workerCategoryCredits(bales,[10,11],10);
    const second=workerCategoryCredits(bales,[10,11],11);
    expect(first.reduce((n,r)=>n+r.count,0)).toBe(7);
    expect(second.reduce((n,r)=>n+r.count,0)).toBe(7);
    expect(first[0].count+second[0].count).toBe(14);
  });
  it("shares a linked table's 14 recorded bales despite uneven scanner finalizers",()=>{
    const bales=[
      ...Array.from({length:11},(_,i)=>({id:i+1,worker:10,category:i<8?"Bags":"Toys"})),
      ...Array.from({length:3},(_,i)=>({id:i+12,worker:11,category:"Shoes"})),
    ];
    expect(workerCategoryCredits(bales,[10,11],10)).toEqual([
      {category:"Bags",count:4},{category:"Shoes",count:1},{category:"Toys",count:2},
    ]);
    expect(workerCategoryCredits(bales,[10,11],11)).toEqual([
      {category:"Bags",count:4},{category:"Shoes",count:2},{category:"Toys",count:1},
    ]);
    expect(workerCategoryCredits(bales,[10,11],10).reduce((n,r)=>n+r.count,0)+
      workerCategoryCredits(bales,[10,11],11).reduce((n,r)=>n+r.count,0)).toBe(14);
  });
  it("splits 42 linked bales as 21 each, and 41 as 21/20",()=>{
    expect([...linkedWorkerBaleShares([{workerId:119,bales:42}],[119,245])]).toEqual([
      [119,21],[245,21],
    ]);
    expect([...linkedWorkerBaleShares([{workerId:119,bales:41}],[119,245])]).toEqual([
      [119,21],[245,20],
    ]);
    expect([...linkedWorkerBaleShares([{workerId:119,bales:42}],[119])]).toEqual([[119,42]]);
  });
  it("preserves category switches without counting the same linked bale twice",()=>{
    const bales=Array.from({length:10},(_,i)=>({
      id:i+1,worker:i%2?3:2,category:i<6?"Bags":"Shoes",
    }));
    expect(workerCategoryCredits(bales,[2,3],2)).toEqual([
      {category:"Bags",count:3},{category:"Shoes",count:2},
    ]);
    expect(workerCategoryCredits(bales,[2,3],3)).toEqual([
      {category:"Bags",count:3},{category:"Shoes",count:2},
    ]);
  });
  it("splits six surplus bales proportionally between Bags and Shoes",()=>{
    expect(splitExtraBalesByCategory(6,[
      {category:"Bags",count:12},{category:"Shoes",count:8},
    ])).toEqual([
      {category:"Bags",count:12,extra:4},
      {category:"Shoes",count:8,extra:2},
    ]);
  });
  it("uses stable alphabetical tie break and never overallocates",()=>{
    const actual=splitExtraBalesByCategory(1,[
      {category:"Toys",count:5},{category:"Bags",count:5},
    ]);
    expect(actual.reduce((n,c)=>n+c.extra,0)).toBe(1);
    expect(actual.find(c=>c.category==="Bags")?.extra).toBe(1);
  });
  it("rejects invalid source amounts and empty category names",()=>{
    expect(()=>splitExtraBalesByCategory(7,[{category:"Bags",count:3}])).toThrow();
    expect(()=>splitExtraBalesByCategory(-1,[{category:"Bags",count:3}])).toThrow();
    expect(()=>workerCategoryCredits([{id:1,worker:2,category:null}],[2],2)).toThrow();
  });
});

describe("weekly production bonus netting",()=>{
  const day=(date:string,produced:number,target:number,workerId=7,frozenExtra?:number)=>({
    date,workerId,produced,target,targetConfigured:true,frozenExtra,
  });
  it("never awards daily surplus when the week's total is below the target",()=>{
    const result=allocateWeeklyExtraBales([
      day("2026-10-19",10,10),day("2026-10-20",9,10),
      day("2026-10-21",12,10),day("2026-10-22",10,10),day("2026-10-23",11,15),
    ]);
    expect(result.get("2026-10-21:7")).toBe(0);
    expect([...result.values()].reduce((sum,value)=>sum+value,0)).toBe(0);
  });
  it("allocates only the net weekly surplus to daily positive contributions",()=>{
    const result=allocateWeeklyExtraBales([
      day("2026-10-19",12,10),day("2026-10-20",8,10),day("2026-10-21",15,10),
    ]);
    // 35 produced - 30 target = 5 payable, NOT the 7 positive daily differences.
    expect(result.get("2026-10-21:7")).toBe(5);
    expect(result.get("2026-10-19:7")).toBe(0);
  });
  it("keeps workers independent and ignores all Sunday targets and output",()=>{
    const result=allocateWeeklyExtraBales([
      day("2026-10-25",12,10),day("2026-10-26",7,10),
      day("2026-10-25",7,10,8),day("2026-10-26",12,10,8),
    ]);
    expect(result.get("2026-10-25:7")).toBe(0);
    expect(result.get("2026-10-26:7")).toBe(0);
    expect(result.get("2026-10-25:8")).toBe(0);
    expect(result.get("2026-10-26:8")).toBe(2);
  });
  it("cannot use a Sunday shortfall to reduce a Monday-Saturday surplus",()=>{
    const result=allocateWeeklyExtraBales([
      day("2026-10-26",12,10),day("2026-10-31",10,10),day("2026-11-01",0,40),
    ]);
    expect(result.get("2026-10-26:7")).toBe(2);
    expect(result.get("2026-11-01:7")).toBe(0);
  });
  it("reserves previously posted entitlement to prevent paying it a second time",()=>{
    const result=allocateWeeklyExtraBales([
      day("2026-10-19",13,10,7,3),day("2026-10-20",12,10),
    ]);
    expect(result.get("2026-10-19:7")).toBe(0);
    expect(result.get("2026-10-20:7")).toBe(2);
  });
  it("blocks new bonuses if a worker produced bales without a configured target",()=>{
    const result=allocateWeeklyExtraBales([
      day("2026-10-19",12,10),{...day("2026-10-20",5,0),targetConfigured:false},
    ]);
    expect(result.get("2026-10-19:7")).toBe(0);
  });
  it("supports fractional linked targets without rounding surplus up",()=>{
    const result=allocateWeeklyExtraBales([
      day("2026-10-19",8,7.5),day("2026-10-20",8,7.5),
    ]);
    expect([...result.values()].reduce((sum,value)=>sum+value,0)).toBe(1);
  });
});
