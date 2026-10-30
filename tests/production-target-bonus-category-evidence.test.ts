import { describe, expect, it } from "vitest";
import {
  buildCategoryEvidence,validateCategoryTargetSplit,
  type CategoryEvidenceBale,type CategoryEvidenceWorker,
} from "../shared/productionTargetBonusCategoryAttribution";

const worker=(id:number,target:number,produced:number,status:"Present"|"Absent"|"New"="Present"):CategoryEvidenceWorker=>({
  workerId:id,targetBales:target,savedProducedBales:produced,status,
});
const bale=(id:number,workerId:number,category:string|null):CategoryEvidenceBale=>({
  baleId:id,workerId,category,finalizedAt:"2026-10-30 09:00:00",
});

describe("Phase 9 frozen bale attribution by worker/day/category",()=>{
  it("preserves intra-day Bags/Toys/Shoes contributions without repeating a worker's target",()=>{
    const result=buildCategoryEvidence([worker(1,8,9)],[],[
      bale(1,1,"Bags"),bale(2,1," Bags "),bale(3,1,"Toys"),
      bale(4,1,"Shoes"),bale(5,1,"Shoes"),bale(6,1,"Shoes"),
      bale(7,1,"Shoes"),bale(8,1,"Toys"),bale(9,1,"Bags"),
    ],true);
    expect(result.readyForTargetAllocation).toBe(true);
    expect(result.sourceBales).toBe(9);
    expect(result.creditedBales).toBe(9);
    const cats=result.workers[0].categories;
    expect(cats.map(c=>[c.categoryKey,c.creditedBales])).toEqual([
      ["bags",3],["shoes",4],["toys",2],
    ]);
    expect(validateCategoryTargetSplit(8,cats,[
      {categoryKey:"bags",targetBales:3},{categoryKey:"shoes",targetBales:4},
      {categoryKey:"toys",targetBales:1},
    ])).toBeNull();
    expect(validateCategoryTargetSplit(8,cats,[
      {categoryKey:"bags",targetBales:8},{categoryKey:"shoes",targetBales:8},
      {categoryKey:"toys",targetBales:8},
    ])).toMatch(/sum/i);
  });
  it("credits linked production to its real finalizer, not an equal split",()=>{
    const result=buildCategoryEvidence([worker(1,7,4),worker(2,7,4)],[
      {id:55,workerIds:[1,2]},
    ],[
      bale(1,1,"Bags"),bale(2,1,"Bags"),bale(3,1,"Bags"),
      bale(4,2,"Toys"),
    ],true);
    expect(result.readyForTargetAllocation).toBe(true);
    expect(result.sourceBales).toBe(4);
    expect(result.creditedBales).toBe(4);
    expect(result.workers.map(w=>w.creditedBales)).toEqual([3,1]);
    expect(result.workers[0].categories.map(c=>[c.categoryKey,c.creditedBales]))
      .toEqual([["bags",3]]);
    expect(result.workers[1].categories.map(c=>[c.categoryKey,c.creditedBales]))
      .toEqual([["toys",1]]);
  });
  it("blocks missing capture, unknown categories, duplicate bale IDs and mismatched frozen totals",()=>{
    const rows=[worker(1,6,2)];
    expect(buildCategoryEvidence(rows,[],[bale(1,1,"Bags")],false).issues).toContain("NO_CAPTURE");
    expect(buildCategoryEvidence(rows,[],[bale(1,1,null),bale(2,1,"Shoes")],true).issues)
      .toContain("MISSING_CATEGORY");
    expect(buildCategoryEvidence(rows,[],[bale(1,1,"Bags"),bale(1,1,"Bags")],true).issues)
      .toContain("DUPLICATE_BALE");
    expect(buildCategoryEvidence(rows,[],[bale(1,1,"Bags")],true).issues)
      .toContain("SAVED_TOTAL_MISMATCH");
  });
  it("blocks absent finalizer and incomplete or overlapping links",()=>{
    expect(buildCategoryEvidence([worker(1,7,1,"Absent")],[],[bale(1,1,"Toys")],true).issues)
      .toContain("ABSENT_FINALIZER");
    expect(buildCategoryEvidence([worker(1,7,1)], [{id:9,workerIds:[1,2]}],
      [bale(1,1,"Shoes")],true).issues).toContain("LINK_MEMBER_MISSING");
    expect(buildCategoryEvidence([worker(1,7,1),worker(2,7,1)],[
      {id:9,workerIds:[1,2]},{id:10,workerIds:[2]},
    ],[bale(1,1,"Shoes")],true).issues).toContain("OVERLAPPING_LINKS");
  });
  it("rejects omitted categories, duplicate categories, fractional mistakes and wrong totals",()=>{
    const cats=buildCategoryEvidence([worker(1,4,2)],[],
      [bale(1,1,"Bags"),bale(2,1,"Shoes")],true).workers[0].categories;
    expect(validateCategoryTargetSplit(4,cats,[{categoryKey:"bags",targetBales:4}])).toBeTruthy();
    expect(validateCategoryTargetSplit(4,cats,[
      {categoryKey:"bags",targetBales:2},{categoryKey:"bags",targetBales:2},
    ])).toBeTruthy();
    expect(validateCategoryTargetSplit(4,cats,[
      {categoryKey:"bags",targetBales:1.001},{categoryKey:"shoes",targetBales:2.999},
    ])).toBeTruthy();
    expect(validateCategoryTargetSplit(4,cats,[
      {categoryKey:"bags",targetBales:1.75},{categoryKey:"shoes",targetBales:2.25},
    ])).toBeNull();
  });
});
