import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  categoryReviewSnapshotPayload, categoryReviewSnapshotToken,
} from "../server/services/factory/categoryBonusReviewSnapshot";
import type { CategoryBonusDayProposal } from "../shared/productionTargetBonusCategoryCalculation";

const harness=vi.hoisted(()=>({
  preview:vi.fn(),
  transaction:vi.fn(),
  rows:new Map<string,unknown[]>(),
  statements:[] as string[],
}));
vi.mock("drizzle-orm",()=>({
  sql:(parts:TemplateStringsArray,...values:unknown[])=>({parts,values}),
}));
vi.mock("../server/db",()=>({db:{transaction:harness.transaction}}));
vi.mock("../server/auth",()=>({requireAuth:(_r:unknown,_s:unknown,next:()=>void)=>next()}));
vi.mock("../server/lib/factoryAccessControl",()=>({
  requireFactoryTabAccess:()=> (_r:unknown,_s:unknown,next:()=>void)=>next(),
}));
vi.mock("../server/lib/logger",()=>({logger:{error:vi.fn()}}));
vi.mock("../server/lib/queryResult",()=>({
  resultRows:(value:{rows?:unknown[]})=>value.rows??[],
}));
vi.mock("../server/services/factory/productionBonusCategoryCalculator",()=>({
  previewProductionBonusCategories:harness.preview,
}));
import { registerProductionBonusCategoryReviewRoutes }
  from "../server/routes/factory/productionBonusCategoryReviewRoutes";

function proposal():CategoryBonusDayProposal {
  return {
    currency:"USD",date:"2026-10-30",calculationVersion:"production-target-category-v1",
    proposalOnly:true,canApprove:false,canPost:false,finalized:true,evidenceVerified:true,
    blockedWorkerCount:0,totalProposedBonusUsd:"3.50",
    workers:[{
      workerId:10,workerName:"Worker Ten",date:"2026-10-30",
      targetBales:"7.00",creditedBales:14,extraBales:"7.00",
      proposedBonusUsd:"3.50",blocked:false,reasons:[],legacyReviewStatus:null,
      lines:[{
        categoryKey:"bags",categoryLabel:"Bags",creditedBales:14,targetBales:"7.00",
        extraBales:"7.00",enabled:true,rateVersionId:12,
        rateEffectiveFrom:"2026-10-01",ratePerExtraBaleUsd:"0.5000",
        unroundedBonusUsd:"3.500000",issue:null,
      }],
    }],
  };
}
function token():string {
  return categoryReviewSnapshotToken(categoryReviewSnapshotPayload(
    "production-target-category-v1",proposal().workers[0],
  ));
}
type FakeQuery={parts:readonly string[];values:unknown[]};
function execute(query:FakeQuery) {
  const stmt=query.parts.join("?").replace(/\s+/g," ");
  harness.statements.push(stmt);
  const lookup=(substring:string,tag:string)=>{
    if(stmt.includes(substring)) return {rows:harness.rows.get(tag)??[]};
    return null;
  };
  if(stmt.includes("SELECT pg_advisory_xact_lock"))return Promise.resolve({rows:[]});
  const out=lookup("FROM factory_target_bonus_category_reviews","prior")
    ??lookup("FROM factory_target_bonus_reviews","legacy")
    ??lookup("FROM factory_target_bonus_category_allocation_sets","allocation")
    ??lookup("FROM factory_production_bonus_allocations","payroll")
    ??lookup("FROM factory_payrolls p","salary")
    ??lookup("INSERT INTO factory_target_bonus_category_reviews","insert");
  return Promise.resolve(out??{rows:[]});
}
const handlers=new Map<string,(req:unknown,res:unknown)=>Promise<unknown>>();
const app={
  get:(path:string,...fns:unknown[])=>{handlers.set("GET "+path,fns.at(-1) as (req:unknown,res:unknown)=>Promise<unknown>);},
  post:(path:string,...fns:unknown[])=>{handlers.set("POST "+path,fns.at(-1) as (req:unknown,res:unknown)=>Promise<unknown>);},
};
registerProductionBonusCategoryReviewRoutes(app as never);
const endpoint="POST /api/factory/production-target-bonuses/category-reviews/decide";
async function invoke(override:Record<string,unknown>={},sessionOverride:Record<string,unknown>={}){
  let status=200,payload:Record<string,unknown>={};
  const res={
    status:(code:number)=>{status=code;return res;},
    setHeader:()=>res,
    json:(body:Record<string,unknown>)=>{payload=body;return res;},
  };
  const req={
    session:{currentRole:"Admin",factoryCompanyId:9,userId:"admin123",...sessionOverride},
    user:{role:"Admin"},
    body:{
      date:"2026-10-30",workerId:10,decision:"approved",
      expectedAmount:"3.50",reviewToken:token(),confirm:true,
      ...override,
    },
  };
  await handlers.get(endpoint)!(req,res);
  return {status,payload};
}
describe("Phase 11 category review transaction boundary",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    harness.rows.clear();harness.statements.length=0;
    harness.rows.set("allocation",[{id:81,dailyTarget:"7.00"}]);
    harness.rows.set("insert",[{id:300}]);
    harness.preview.mockResolvedValue(proposal());
    harness.transaction.mockImplementation((fn:(tx:{execute:typeof execute})=>unknown)=>fn({execute}));
  });
  it("locks one company and saves one frozen category approval without a payment",async()=>{
    const result=await invoke();
    expect(result.status).toBe(201);
    expect(result.payload).toMatchObject({
      success:true,replayed:false,status:"approved",
      accountingPosted:false,paymentEnabled:false,amount:"3.50",
    });
    expect(harness.statements.some(s=>s.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(harness.statements.filter(s=>s.includes("INSERT INTO factory_target_bonus_category_reviews"))).toHaveLength(1);
    expect(harness.statements.some(s=>s.includes("INSERT INTO factory_target_bonus_payments"))).toBe(false);
  });
  it("rejects a stale amount/token and makes no review row",async()=>{
    const result=await invoke({expectedAmount:"3.51"});
    expect(result.status).toBe(409);
    expect(harness.statements.some(s=>s.includes("INSERT INTO factory_target_bonus_category_reviews"))).toBe(false);
    const stale=await invoke({reviewToken:"0".repeat(64)});
    expect(stale.status).toBe(409);
  });
  it("blocks a reviewed legacy daily bonus before a category claim",async()=>{
    harness.rows.set("legacy",[{id:44}]);
    const result=await invoke();
    expect(result.status).toBe(409);
    expect(harness.preview).not.toHaveBeenCalled();
  });
  it("blocks an already-claimed payroll amount and approved salary",async()=>{
    harness.rows.set("payroll",[{blocked:1}]);
    expect((await invoke()).status).toBe(409);
    harness.rows.delete("payroll");
    harness.rows.set("salary",[{blocked:1}]);
    expect((await invoke()).status).toBe(409);
  });
  it("allows an identical replay but rejects conflicting historical status",async()=>{
    harness.rows.set("prior",[{
      id:99,status:"approved",amount:"3.50",snapshotHash:token(),note:null,
    }]);
    expect((await invoke()).payload).toMatchObject({replayed:true,reviewId:99});
    expect((await invoke({decision:"rejected"})).status).toBe(409);
    expect(harness.preview).not.toHaveBeenCalled();
  });
  it("accepts a rejection as audit-only, without salary-payment lookup",async()=>{
    const result=await invoke({decision:"rejected",note:"Review rejected"});
    expect(result.status).toBe(201);
    expect(result.payload).toMatchObject({status:"rejected",accountingPosted:false});
    expect(harness.statements.some(s=>s.includes("FROM factory_payrolls p"))).toBe(false);
  });
  it("rejects a non-admin, wrong factory selection or missing confirmation",async()=>{
    expect((await invoke({}, {currentRole:"Viewer"})).status).toBe(403);
    expect((await invoke({}, {factoryCompanyId:null})).status).toBe(400);
    expect((await invoke({confirm:false})).status).toBe(400);
  });
});
