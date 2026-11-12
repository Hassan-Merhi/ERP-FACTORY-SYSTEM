/**
 * Read-only integrity checks for Factory dispatch trip postings.
 *
 * A posted truck is not the same thing as a signed all-truck reconciliation.
 * Before the operator signs, the consolidation snapshot can legitimately be
 * absent (or contain zero defaults). Never flag those zeros as financial
 * mismatches; still validate individual POST identities and monetary math.
 */
import { MoneyDecimal,sumMoney } from "../../lib/money";

export type DispatchIntegrityState="PASS"|"BLOCK"|"INFO"|"NOT_APPLICABLE";
export interface DispatchIntegrityCheck {
  code:string;state:DispatchIntegrityState;message:string;
  expected?:string;observed?:string;
}
export interface DispatchPostingRow {
  status:unknown;
  postingId:unknown;
  goods:unknown;
  billable:unknown;
  discounts:unknown;
  total:unknown;
}
export interface DispatchSignedSnapshot {
  isSigned:boolean;
  postingIds:unknown;
  goods:unknown;
  billable:unknown;
  discounts:unknown;
  total:unknown;
}
export interface DispatchPostingSnapshotReport {
  checks:DispatchIntegrityCheck[];
  postedCount:number;
  goods:string;
  billable:string;
  discounts:string;
  receivable:string;
}

const str=(x:unknown)=>String(x??"");
const amount=(x:unknown)=>new MoneyDecimal(str(x??"0"));
const fixed=(x:unknown)=>amount(x).toDecimalPlaces(2).toFixed(2);
const ids=(value:unknown):string[]=>
  Array.isArray(value)?value.map(str).sort():[];

export function inspectDispatchTripPostingSnapshot(
  trips:DispatchPostingRow[], signed:DispatchSignedSnapshot,
):DispatchPostingSnapshotReport{
  const posted=trips.filter(row=>
    row.status==="POSTED"||row.status==="CONSOLIDATED");
  const checks:DispatchIntegrityCheck[]=[];
  const pass=(code:string,message:string,valid:boolean,expected:unknown,observed:unknown)=>{
    checks.push({code,message,state:valid?"PASS":"BLOCK",
      expected:str(expected),observed:str(observed)});
  };
  const goods=sumMoney(posted.map(row=>str(row.goods))).toFixed(2);
  const billable=sumMoney(posted.map(row=>str(row.billable))).toFixed(2);
  const discounts=sumMoney(posted.map(row=>str(row.discounts))).toFixed(2);
  const receivable=sumMoney(posted.map(row=>str(row.total))).toFixed(2);
  const actualIds=posted.map(row=>str(row.postingId)).sort();
  const validIdentity=posted.every(row=>row.postingId!=null && str(row.postingId)!=="") &&
    new Set(actualIds).size===actualIds.length;

  // These checks apply even before reconciliation. Never hide an actual
  // missing/duplicated POST or an invalid per-trip customer total.
  if(posted.length>0){
    pass("POSTED_TRIP_IDENTITIES",
      "Each posted truck has a unique original POST identity",
      validIdentity,"One unique POST per posted truck",
      actualIds.join(","));
    pass("POSTED_TRIP_TOTAL_MATH",
      "Every posted truck receivable equals goods plus billable fees minus discounts",
      posted.every(row=>amount(row.goods).plus(amount(row.billable))
        .minus(amount(row.discounts)).eq(amount(row.total))),
      "Goods + billable fees - discounts for each truck",
      posted.length+" posted truck(s)");
  }else{
    checks.push({code:"NO_POSTED_TRIPS",state:"INFO",
      message:"No financially posted trucks to verify yet."});
  }

  const signedChecks=[
    ["TRIP_POST_IDENTITIES","Every included truck has one original POST identity"],
    ["SIGNED_TRIP_GOODS","Combined goods equal the sum of posted truck goods"],
    ["SIGNED_TRIP_CHARGES","Combined charges equal original truck billable fees"],
    ["SIGNED_TRIP_RECEIVABLE","Truck receivable is goods + billable fees - discounts"],
  ] as const;
  if(!signed.isSigned){
    for(const [code,message] of signedChecks){
      checks.push({code,state:"NOT_APPLICABLE",
        message:message+" (awaiting signed all-truck reconciliation)"});
    }
    return {checks,postedCount:posted.length,goods,billable,discounts,receivable};
  }

  const expectedIds=ids(signed.postingIds);
  pass("TRIP_POST_IDENTITIES",signedChecks[0][1],
    posted.length>0 && validIdentity &&
    JSON.stringify(actualIds)===JSON.stringify(expectedIds),
    expectedIds.join(","),actualIds.join(","));
  pass("SIGNED_TRIP_GOODS",signedChecks[1][1],
    goods===fixed(signed.goods),fixed(signed.goods),goods);
  pass("SIGNED_TRIP_CHARGES",signedChecks[2][1],
    billable===fixed(signed.billable) && discounts===fixed(signed.discounts),
    fixed(signed.billable)+" / "+fixed(signed.discounts),
    billable+" / "+discounts);
  pass("SIGNED_TRIP_RECEIVABLE",signedChecks[3][1],
    receivable===fixed(signed.total) &&
      amount(goods).plus(billable).minus(discounts).eq(receivable),
    fixed(signed.total),receivable);

  return {checks,postedCount:posted.length,goods,billable,discounts,receivable};
}
