import { productionBonusCheckoutErrors as errors } from "./i18n/productionBonusCheckoutErrors";
import Decimal from "decimal.js";
import { mondayOfProductionBonusWeek } from "./productionTargetBonusWeeklyMethod";
/** Attribute each Stock Entry bale to the worker who finalized it.
 * Linking workers at the same table does not transfer or split their bonus
 * credits; category totals must match the individual preview exactly.
 */
export function workerCategoryCredits(
  bales: ReadonlyArray<{id:number;worker:number|null;category:string|null}>,
  members: readonly number[],
  workerId: number,
): Array<{category:string;count:number}> {
  const ids=[...new Set(members)];
  if(!ids.includes(workerId))throw new Error(errors.missingLink);
  const group=new Map<string,number>();
  for(const bale of bales){
    if(bale.worker!==workerId)continue;
    const name=(bale.category??"").normalize("NFC").trim().replace(/\s+/gu," ");
    if(!name)throw new Error(errors.missingCategory);
    group.set(name,(group.get(name)??0)+1);
  }
  return [...group].map(([category,count])=>({category,count}))
    .sort((a,b)=>a.category.localeCompare(b.category));
}

/** Allocate integer extra bales proportionally to production by category.
 * Floor shares first, then distribute remainder in stable largest-fraction order.
 * Output extras sum exactly to the approved worker-day excess, not category sum.
 */
export function splitExtraBalesByCategory(
  extra:number,
  categories:ReadonlyArray<{category:string;count:number}>,
): Array<{category:string;count:number;extra:number}>{
  if(!Number.isSafeInteger(extra)||extra<0||
     categories.some(c=>!Number.isSafeInteger(c.count)||c.count<0))
    throw new Error(errors.invalidQuantities);
  const produced=categories.reduce((sum,c)=>sum+c.count,0);
  if(!produced)return categories.map(c=>({...c,extra:0}));
  if(extra>produced)throw new Error(errors.excessExceedsProduced);
  const split=categories.map(c=>{
    const exact=(extra*c.count)/produced;
    const base=Math.floor(exact);
    return {...c,extra:base,fraction:exact-base};
  });
  let remainder=extra-split.reduce((sum,c)=>sum+c.extra,0);
  for(const item of [...split].sort((a,b)=>b.fraction-a.fraction||
      a.category.localeCompare(b.category))){
    if(remainder===0)break;
    item.extra++;remainder--;
  }
  return split.map(({category,count,extra})=>({category,count,extra}));
}

/**
 * Calculate one worker's payable extra bales across a MONDAY–SUNDAY production
 * week, instead of adding positive daily overages while ignoring short days.
 *
 * Daily assignments are only accounting/category attribution for the earned
 * weekly surplus. Allocate against positive daily contributions, newest first;
 * a day below target can never invent extra bales. Already posted/reversed
 * claims reserve their frozen extra bales and cannot be paid twice.
 */
export type WeeklyBonusDay = {
  date: string; workerId: number; target: number; produced: number;
  targetConfigured: boolean; frozenExtra?: number;
};
export function allocateWeeklyExtraBales(days: readonly WeeklyBonusDay[]): Map<string,number> {
  const result=new Map<string,number>();
  const weeks=new Map<string,WeeklyBonusDay[]>();
  for(const day of days){
    const monday=mondayOfProductionBonusWeek(day.date);
    if(!monday)throw new Error("Invalid production week date");
    const key=monday+":"+day.workerId;
    result.set(day.date+":"+day.workerId,0);
    const bucket=weeks.get(key)??[];
    bucket.push(day);
    weeks.set(key,bucket);
  }
  for(const weekDays of weeks.values()){
    // A missing target on a day that actually produced bales must not become
    // an artificial positive weekly difference.
    if(weekDays.some(day=>day.produced>0 && (!day.targetConfigured || day.target<=0)))continue;
    const produced=weekDays.reduce((sum,day)=>sum.plus(day.produced),new Decimal(0));
    const target=weekDays.reduce((sum,day)=>sum.plus(day.target),new Decimal(0));
    const frozen=weekDays.reduce((sum,day)=>sum.plus(Math.max(0,day.frozenExtra??0)),new Decimal(0));
    let remaining=Decimal.max(0,produced.minus(target).minus(frozen));
    for(const day of [...weekDays].sort((a,b)=>b.date.localeCompare(a.date))){
      if(day.frozenExtra!==undefined)continue;
      const positive=Decimal.max(0,new Decimal(day.produced).minus(day.target));
      const allocated=Decimal.min(positive,remaining);
      result.set(day.date+":"+day.workerId,Number(allocated.toDecimalPlaces(6).toString()));
      remaining=remaining.minus(allocated);
      if(remaining.lte(0))break;
    }
  }
  return result;
}
