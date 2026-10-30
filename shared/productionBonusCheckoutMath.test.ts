import {describe,expect,it} from "vitest";
import {splitExtraBalesByCategory,workerCategoryCredits} from "./productionBonusCheckoutMath";

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
