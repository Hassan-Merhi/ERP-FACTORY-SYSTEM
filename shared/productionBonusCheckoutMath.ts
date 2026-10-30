import { productionBonusCheckoutErrors as errors } from "./i18n/productionBonusCheckoutErrors";
/** Deterministic category attribution for linked worker groups.
 * Each physical bale belongs to one worker, and the floor/remainder split
 * agrees with the existing Production Targets linked-worker count.
 */
export function workerCategoryCredits(
  bales: ReadonlyArray<{id:number;worker:number|null;category:string|null}>,
  members: readonly number[],
  workerId: number,
): Array<{category:string;count:number}> {
  const ids=[...new Set(members)].sort((a,b)=>a-b);
  const rank=ids.indexOf(workerId);
  if(rank<0)throw new Error(errors.missingLink);
  const group=new Map<string,number>();
  for(let i=0;i<bales.length;i++){
    const bale=bales[i];
    if(ids.length===1 ? bale.worker!==workerId : i%ids.length!==rank)continue;
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
