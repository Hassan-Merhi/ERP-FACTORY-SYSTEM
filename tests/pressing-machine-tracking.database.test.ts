/**
 * Real PostgreSQL integration tests for the simplified Ground-Scan-style
 * Pressing Scan workflow. A Factory page/tab permission is the worker setup.
 * This suite tests internal station activation, actor-scoped confirmations,
 * idempotent retries, duplicate races, per-user history and audited correction.
 * It never modifies Factory bale status, stock, costing or vouchers.
 *
 * Uses a dedicated test DATABASE_URL; do not run against production.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, requireAuth: pass, requireNonPOS: pass, requireRole: () => pass };
});
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { registerFactoryPressingMachineManagementRoutes } from "../server/routes/factory/factoryPressingMachineManagementRoutes";
import { registerFactoryPressingConfirmRoutes } from "../server/routes/factory/factoryPressingConfirmationRoutes";
import { registerFactoryPressingReportRoutes } from "../server/routes/factory/factoryPressingReportRoutes";
import { registerFactoryPressingCorrectionRoutes } from "../server/routes/factory/factoryPressingCorrectionRoutes";

const databaseDescribe = process.env.DATABASE_URL ? describe : describe.skip;
type Handler = (req: any, res: any, next: () => void) => unknown;
const routes = new Map<string, Handler[]>();
const app: any = new Proxy({}, {
  get: (_target, method: string) =>
    (path: string, ...handlers: Handler[]) => routes.set(method.toUpperCase() + " " + path, handlers),
});
registerFactoryPressingMachineManagementRoutes(app);
registerFactoryPressingConfirmRoutes(app);
registerFactoryPressingReportRoutes(app);
registerFactoryPressingCorrectionRoutes(app);

interface Actor { userId: string; companyId: number; username: string }
interface CallOptions {
  body?: unknown; params?: Record<string, string>; query?: Record<string, unknown>;
}
async function call(route: string, actor: Actor, options: CallOptions = {}) {
  const handlers = routes.get(route);
  if (!handlers) throw new Error("Unregistered pressing route: " + route);
  const [method,path] = route.split(" ");
  const res: any = {
    statusCode: 200, body: undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(value: unknown) { res.body = value; return res; },
    set: () => res, setHeader: () => res,
  };
  const req = {
    method,path,originalUrl:path, params:options.params ?? {},
    query:options.query ?? {},body:options.body ?? {},
    session: {
      userId:actor.userId,username:actor.username,
      factoryCompanyId:actor.companyId,currentCompanyId:actor.companyId,
    },
  };
  for(const handler of handlers){
    let advanced=false;
    await handler(req,res,()=>{advanced=true;});
    if(!advanced)break;
  }
  return res as {statusCode:number;body:any};
}
const rows=async(query:ReturnType<typeof sql>) =>
  ((await db.execute(query)) as any).rows as any[];
const one=async(query:ReturnType<typeof sql>) => Number((await rows(query))[0]?.id);
type Assigned={assignmentId:number;machineId:number;machineCode:string;machineName:string};
databaseDescribe("Pressing Scan — simplified user-based PostgreSQL integration",()=>{
  const suffix=process.pid+"-"+(Date.now()%1000000);
  const companies:{a:number;b:number}={a:0,b:0};
  const actors:Record<string,Actor>={};
  const bales:Record<string,{id:number;ref:string}>={};
  const assignments:Record<string,Assigned>={};
  let voucherCountBefore=0;

  async function fixtureUser(key:string,companyId:number,role:string,options:{posViewOnly?:boolean;active?:boolean}={}){
    const id="pressing-"+key+"-"+suffix;
    await db.execute(sql`INSERT INTO users(id,username,password,active)
      VALUES(${id},${key+suffix},'x',${options.active??true})`);
    await db.execute(sql`INSERT INTO user_company_roles(user_id,company_id,role,pos_view_only)
      VALUES(${id},${companyId},${role},${options.posViewOnly??false})`);
    await db.execute(sql`INSERT INTO factory_user_profiles(company_id,user_id,display_name)
      VALUES(${companyId},${id},${"Display "+key})`);
    actors[key]={userId:id,companyId,username:key+suffix};
  }
  async function fixtureBale(key:string,companyId:number,status="PENDING_PRESSING",deleted=false){
    const ref="PRS-"+key.toUpperCase()+"-"+suffix;
    const id=await one(sql`INSERT INTO factory_bales(company_id,bale_code,reference_number,article_code,product_name,weight_kg,status,deleted_at)
      VALUES(${companyId},${ref},${ref},${"ART-"+key},${"Bale "+key},45.5,${status},${deleted?sql`now()`:null}) RETURNING id`);
    bales[key]={id,ref};
  }
  async function activate(user:Actor){
    return call("POST /api/factory/pressing-machines/activate",user);
  }
  async function scan(user:Actor,key:string,requestId=randomUUID(),override?:Assigned){
    const a=override||assignments[user.userId];
    return call("POST /api/factory/pressing-machines/confirm",user,{
      body:{barcode:bales[key].ref,requestId,
        assignmentId:a.assignmentId,machineId:a.machineId,
        deviceCapturedAt:new Date().toISOString()},
    });
  }
  async function baleUnchanged(key:string, expectedStatus="PENDING_PRESSING"){
    const [bale]=await rows(sql`SELECT status,weight_kg::text AS weight,pressed_at,finalized_at
      FROM factory_bales WHERE id=${bales[key].id}`);
    expect(bale).toMatchObject({
      status:expectedStatus,weight:"45.500",pressed_at:null,finalized_at:null,
    });
    const [count]=await rows(sql`SELECT COUNT(*)::int AS total FROM vouchers`);
    expect(count.total).toBe(voucherCountBefore);
  }

  beforeAll(async()=>{
    companies.a=await one(sql`INSERT INTO companies(code,name,company_type)
      VALUES(${"PRA"+suffix},'Pressing A','factory') RETURNING id`);
    companies.b=await one(sql`INSERT INTO companies(code,name,company_type)
      VALUES(${"PRB"+suffix},'Pressing B','factory') RETURNING id`);
    await db.execute(sql`INSERT INTO factory_settings(company_id,extra_settings)
      VALUES(${companies.a},${JSON.stringify({pressingTimezone:"Africa/Lubumbashi"})}::jsonb)`);
    await fixtureUser("supA",companies.a,"Admin");
    await fixtureUser("opA1",companies.a,"Worker");
    await fixtureUser("opA2",companies.a,"Worker");
    await fixtureUser("managerA",companies.a,"Manager");
    await fixtureUser("viewA",companies.a,"View Only");
    await fixtureUser("posA",companies.a,"Manager",{posViewOnly:true});
    await fixtureUser("supB",companies.b,"Admin");
    await fixtureUser("opB1",companies.b,"Worker");
    for(const [key,company,status,deleted] of [
      ["one",companies.a,"PENDING_PRESSING",false],
      ["two",companies.a,"PENDING_PRESSING",false],
      ["race",companies.a,"PENDING_PRESSING",false],
      ["void",companies.a,"PENDING_PRESSING",false],
      ["done",companies.a,"IN_STOCK",false],
      ["reserved",companies.a,"RESERVED_FOR_ORDER",false],
      ["final",companies.a,"FINALIZED",false],
      ["sold",companies.a,"SOLD",false],
      ["dispatched",companies.a,"DISPATCHED",false],
      ["deleted",companies.a,"DELETED",false],
      ["gone",companies.a,"PENDING_PRESSING",true],
      ["other",companies.b,"PENDING_PRESSING",false],
    ] as Array<[string,number,string,boolean]>){
      await fixtureBale(key,company,status,deleted);
    }
    const [count]=await rows(sql`SELECT COUNT(*)::int AS total FROM vouchers`);
    voucherCountBefore=count.total;
  },60000);

  afterAll(async()=>{
    if(!companies.a)return;
    const conn=await pool.connect();
    try{
      await conn.query("BEGIN");
      // Same protected-fixture cleanup as the previous integration test:
      // disable immutable audit triggers only for test teardown.
      await conn.query("SET LOCAL session_replication_role = replica");
      const ids=[companies.a,companies.b];
      for(const table of [
        "factory_pressing_corrections","factory_pressing_confirmations",
        "factory_pressing_downtime","factory_pressing_sessions",
        "factory_pressing_assignments","factory_pressing_shifts",
        "factory_pressing_saved_views","factory_pressing_machines",
        "factory_bales","factory_settings","factory_user_profiles","user_company_roles",
      ]){
        await conn.query("DELETE FROM "+table+" WHERE company_id = ANY($1::int[])",[ids]);
      }
      await conn.query("DELETE FROM users WHERE id LIKE $1",["pressing-%-"+suffix]);
      await conn.query("DELETE FROM companies WHERE id = ANY($1::int[])",[ids]);
      await conn.query("COMMIT");
    }catch(error){
      await conn.query("ROLLBACK").catch(()=>undefined);throw error;
    }finally{conn.release();}
    await deleteAuditLogRowsForTests(pool,"company_id = ANY($1::int[])",[[companies.a,companies.b]]);
  });

  it("retains only the needed Ground-Scan-style APIs",()=>{
    expect(routes.has("GET /api/factory/pressing-machines/me")).toBe(true);
    expect(routes.has("POST /api/factory/pressing-machines/activate")).toBe(true);
    expect(routes.has("POST /api/factory/pressing-machines/confirm")).toBe(true);
    expect(routes.has("GET /api/factory/pressing-machines/report")).toBe(true);
    for(const route of [
      "GET /api/factory/pressing-machines/shifts",
      "POST /api/factory/pressing-machines/downtime/start",
      "GET /api/factory/pressing-machines/analytics",
      "POST /api/factory/pressing-machines/assignments",
    ]) expect(routes.has(route)).toBe(false);
  });

  it("automatically activates permitted users, keeps one assignment, and rejects view-only",async()=>{
    expect((await activate(actors.viewA)).statusCode).toBe(403);
    expect((await activate(actors.posA)).statusCode).toBe(403);
    const repeated=await Promise.all([activate(actors.opA1),activate(actors.opA1),activate(actors.opA1)]);
    expect(repeated.every(r=>r.statusCode===200)).toBe(true);
    expect(new Set(repeated.map(r=>r.body.assignment.assignmentId)).size).toBe(1);
    for(const name of ["opA1","opA2","opB1"]){
      const result=name==="opA1"?repeated[0]:await activate(actors[name]);
      expect(result.statusCode).toBe(200);
      expect(result.body.companyId).toBe(actors[name].companyId);
      expect(result.body.userId).toBe(actors[name].userId);
      expect(result.body.assignment.machineCode).toBe("PRESSING-SCAN");
      assignments[actors[name].userId]=result.body.assignment;
      const me=await call("GET /api/factory/pressing-machines/me",actors[name]);
      expect(me.body.assignment.assignmentId).toBe(result.body.assignment.assignmentId);
      const [count]=await rows(sql`SELECT COUNT(*)::int AS total FROM factory_pressing_assignments
        WHERE company_id=${actors[name].companyId} AND user_id=${actors[name].userId} AND unassigned_at IS NULL`);
      expect(count.total).toBe(1);
    }
    expect(assignments[actors.opA1.userId].machineId)
      .toBe(assignments[actors.opA2.userId].machineId);
    expect(assignments[actors.opA1.userId].machineId)
      .not.toBe(assignments[actors.opB1.userId].machineId);
  });

  it("stores operator, seconds-precision server time and KG without a shift",async()=>{
    const requestId=randomUUID();
    const response=await scan(actors.opA1,"one",requestId);
    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      status:"PRESSING_COMPLETED",requestId,referenceNumber:bales.one.ref,
      machineName:"Pressing Scan",operatorUserId:actors.opA1.userId,
      inventoryFinalized:false,shiftId:null,weightKg:"45.500",
    });
    expect(Date.parse(response.body.confirmedAt)).not.toBeNaN();
    expect(response.body.productionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A prior company setting must not shift pressing away from Beirut.
    expect(response.body.timezoneName).toBe("Asia/Beirut");
    const expectedBeirutDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(response.body.confirmedAt));
    expect(response.body.productionDate).toBe(expectedBeirutDay);
    const [record]=await rows(sql`SELECT * FROM factory_pressing_confirmations
      WHERE company_id=${companies.a} AND bale_id=${bales.one.id}`);
    expect(record.shift_id).toBeNull();
    expect(record.voided_at).toBeNull();
    const replay=await scan(actors.opA1,"one",requestId);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({id:response.body.id,replayed:true});
    const hijack=await scan(actors.opA1,"two",requestId);
    expect(hijack.body.code).toBe("PRESSING_REQUEST_ID_REUSED");
    await baleUnchanged("one");
  });

  it("enforces lifetime duplicate prevention for user A and user B",async()=>{
    const duplicate=await scan(actors.opA2,"one");
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body.code).toBe("PRESSING_ALREADY_CONFIRMED");
    expect(duplicate.body.previous).toMatchObject({
      operatorName:"Display opA1",
      operatorUserId:actors.opA1.userId,
      referenceNumber:bales.one.ref,
    });
    const a=assignments[actors.opA1.userId];
    const foreign=await call("POST /api/factory/pressing-machines/confirm",actors.opB1,{
      body:{barcode:bales.one.ref,assignmentId:a.assignmentId,machineId:a.machineId,
        requestId:randomUUID()},
    });
    expect(foreign.statusCode).toBeGreaterThanOrEqual(400);
    expect((await scan(actors.opA1,"deleted")).statusCode).toBe(404);
    expect((await scan(actors.opA1,"gone")).statusCode).toBe(404);
    const unauthorized=await scan(actors.viewA,"two",randomUUID(),a);
    expect(unauthorized.body.code).toBe("PRESSING_WRITE_DENIED");
    const stolen=await scan(actors.opA2,"two",randomUUID(),a);
    expect(stolen.body.code).toBe("PRESSING_ASSIGNMENT_CHANGED");
  });

  it("shows updated Factory display names in old history, totals, and duplicate alerts",async()=>{
    await db.execute(sql`UPDATE factory_user_profiles SET display_name=${"Updated Operator One"}
      WHERE company_id=${companies.a} AND user_id=${actors.opA1.userId}`);
    const history=await call("GET /api/factory/pressing-machines/report",actors.supA,{
      query:{mode:"detailed",status:"active"},
    });
    expect(history.statusCode).toBe(200);
    const entry=history.body.rows.find((row:any)=>row.operatorUserId===actors.opA1.userId);
    expect(entry.operatorName).toBe("Updated Operator One");
    expect(history.body.summary.byOperator.find((row:any)=>row.userId===actors.opA1.userId).name)
      .toBe("Updated Operator One");
    const duplicate=await scan(actors.opA2,"one");
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body.previous.operatorName).toBe("Updated Operator One");
    await db.execute(sql`UPDATE factory_user_profiles SET display_name=${"Display opA1"}
      WHERE company_id=${companies.a} AND user_id=${actors.opA1.userId}`);
  });

  it("records a first pressing scan at every non-deleted inventory stage without stock writes",async()=>{
    for (const [key,status] of [
      ["done","IN_STOCK"],
      ["reserved","RESERVED_FOR_ORDER"],
      ["final","FINALIZED"],
      ["sold","SOLD"],
      ["dispatched","DISPATCHED"],
    ] as const) {
      const first=await scan(actors.opA1,key);
      expect(first.statusCode).toBe(201);
      expect(first.body).toMatchObject({
        status:"PRESSING_COMPLETED",
        referenceNumber:bales[key].ref,
        inventoryFinalized:false,
      });
      await baleUnchanged(key,status);
      const second=await scan(actors.opA2,key);
      expect(second.statusCode).toBe(409);
      expect(second.body.code).toBe("PRESSING_ALREADY_CONFIRMED");
    }
  });

  it("allows one and only one accepted scan in simultaneous user races",async()=>{
    const raced=await Promise.all([
      scan(actors.opA1,"race"),scan(actors.opA2,"race"),
    ]);
    expect(raced.filter(x=>x.statusCode===201)).toHaveLength(1);
    expect(raced.filter(x=>x.statusCode===409)).toHaveLength(1);
    const stored=await rows(sql`SELECT id FROM factory_pressing_confirmations
      WHERE bale_id=${bales.race.id} AND voided_at IS NULL`);
    expect(stored).toHaveLength(1);
    await baleUnchanged("race");
  });

  it("reports filtered confirmed bale totals by authorized user, never across companies",async()=>{
    expect((await scan(actors.opA2,"two")).statusCode).toBe(201);
    const all=await call("GET /api/factory/pressing-machines/report",actors.supA,{
      query:{status:"active"},
    });
    expect(all.statusCode).toBe(200);
    expect(all.body.summary.totalBales).toBeGreaterThanOrEqual(3);
    const own=await call("GET /api/factory/pressing-machines/report",actors.supA,{
      query:{userId:actors.opA2.userId,status:"active"},
    });
    expect(own.body.rows.every((x:any)=>x.operatorUserId===actors.opA2.userId)).toBe(true);
    const worker=await call("GET /api/factory/pressing-machines/report",actors.opA1,{
      query:{status:"active"},
    });
    expect(worker.body.rows.every((x:any)=>x.operatorUserId===actors.opA1.userId)).toBe(true);
    const denial=await call("GET /api/factory/pressing-machines/report",actors.opA1,{
      query:{userId:actors.opA2.userId},
    });
    expect(denial.statusCode).toBe(403);
    const other=await call("GET /api/factory/pressing-machines/report",actors.supB);
    expect(other.body.total).toBe(0);
    const options=await call("GET /api/factory/pressing-machines/report/options",actors.supA);
    expect(options.body.timeZone).toBe("Asia/Beirut");
    expect(options.body.operators.map((x:any)=>x.userId)).toContain(actors.opA1.userId);
    expect(options.body.machines).toBeUndefined();
    expect((await call("GET /api/factory/pressing-machines/report/options",actors.opA1)).body.canViewAll).toBe(false);
    // Manager is not an Admin/Owner: their report and correction access must
    // remain restricted even if they can use other Factory management pages.
    const managerHistory=await call("GET /api/factory/pressing-machines/report",actors.managerA,{
      query:{userId:actors.opA2.userId},
    });
    expect(managerHistory.statusCode).toBe(403);
    expect((await call("GET /api/factory/pressing-machines/report/options",actors.managerA)).body.canViewAll).toBe(false);
    expect((await call("GET /api/factory/pressing-machines/me",actors.managerA)).body.canManage).toBe(false);
    expect((await call("GET /api/factory/pressing-machines/me",actors.supA)).body.canManage).toBe(true);
  });

  it("requires a supervisor reason, leaves an immutable void, then links the replacement",async()=>{
    const first=await scan(actors.opA1,"void",randomUUID());
    expect(first.statusCode).toBe(201);
    const route="POST /api/factory/pressing-machines/confirmations/:id/void";
    const options={params:{id:String(first.body.id)},body:{reason:"Wrong bale reference confirmed in error"}};
    expect((await call(route,actors.opA1,options)).statusCode).toBe(403);
    expect((await call(route,actors.managerA,options)).statusCode).toBe(403);
    expect((await call(route,actors.posA,options)).statusCode).toBe(403);
    expect((await call(route,actors.supB,options)).statusCode).toBe(404);
    expect((await call(route,actors.supA,{...options,body:{reason:"short"}})).statusCode).toBe(400);
    const corrected=await call(route,actors.supA,options);
    expect(corrected.statusCode).toBe(200);
    expect(corrected.body).toMatchObject({confirmationId:first.body.id,needsRescan:true,stockFinalized:false});
    expect((await call(route,actors.supA,options)).statusCode).toBe(409);
    const [original]=await rows(sql`SELECT * FROM factory_pressing_confirmations WHERE id=${first.body.id}`);
    expect(original.voided_by).toBe(actors.supA.userId);
    expect(original.voided_at).not.toBeNull();
    expect((await scan(actors.opA1,"void",first.body.requestId)).body.code)
      .toBe("PRESSING_CONFIRMATION_VOIDED");
    const replacement=await scan(actors.opA2,"void");
    expect(replacement.statusCode).toBe(201);
    expect(replacement.body.id).not.toBe(first.body.id);
    const correctedRecords=await rows(sql`SELECT action,confirmation_id,replacement_confirmation_id
      FROM factory_pressing_corrections WHERE confirmation_id=${first.body.id}`);
    expect(correctedRecords.map(x=>x.action).sort()).toEqual(["RECONFIRM","VOID"]);
    expect(correctedRecords.find(x=>x.action==="RECONFIRM")?.replacement_confirmation_id)
      .toBe(replacement.body.id);
    const active=await rows(sql`SELECT id FROM factory_pressing_confirmations
      WHERE bale_id=${bales.void.id} AND voided_at IS NULL`);
    expect(active).toHaveLength(1);
    await expect(db.execute(sql`DELETE FROM factory_pressing_confirmations
      WHERE id=${first.body.id}`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM factory_pressing_corrections
      WHERE confirmation_id=${first.body.id}`)).rejects.toThrow();
    await baleUnchanged("void");
  });
});
