import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORE_TABLES,CONTROL_TABLES,CORE_CONSTRAINTS,CONTROL_CONSTRAINTS,
  CORE_TRIGGERS,CONTROL_TRIGGERS,evaluateCatalogIntegrity
} from "../scripts/database-integrity-catalog-core.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");

function snapshot(){
  return {
    tables:[...CORE_TABLES,...CONTROL_TABLES],
    constraints:[...CORE_CONSTRAINTS,...CONTROL_CONSTRAINTS].map(([table_name,constraint_name])=>({
      table_name,constraint_name,validated:true
    })),
    triggers:[...CORE_TRIGGERS,...CONTROL_TRIGGERS].map(([table_name,trigger_name])=>({
      table_name,trigger_name,enabled:"O"
    })),
    rls:[{table_name:"voucher_entries",enabled:true,forced:true,policyCount:1}]
  };
}

test("full catalogue with enabled guards and forced RLS is structurally healthy",()=>{
  const result=evaluateCatalogIntegrity(snapshot());
  assert.equal(result.ok,true,result.errors.join("; "));
  assert.deepEqual(result.warnings,[]);
});
test("missing core table and a missing enabled trigger both fail closed",()=>{
  const snap=snapshot();
  snap.tables=snap.tables.filter(x=>x!=="vouchers");
  snap.triggers=snap.triggers.filter(x=>x.trigger_name!=="voucher_entries_target_guard");
  const result=evaluateCatalogIntegrity(snap);
  assert.equal(result.ok,false);
  assert.ok(result.errors.includes("missing-table:vouchers"));
  assert.ok(result.errors.includes("missing-trigger:voucher_entries.voucher_entries_target_guard"));
});
test("tenant-company permissions and POS guard gaps are detected if installed",()=>{
  const snap=snapshot();
  snap.constraints=snap.constraints.filter(x=>x.constraint_name!=="user_company_roles_company_fk");
  snap.triggers=snap.triggers.map(x=>x.trigger_name==="user_locations_tenant_guard"?{...x,enabled:"D"}:x);
  const result=evaluateCatalogIntegrity(snap);
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(x=>x.includes("user_company_roles_company_fk")));
  assert.ok(result.errors.includes("disabled-trigger:user_locations.user_locations_tenant_guard"));
});
test("legacy NOT VALID foreign keys are reported, not incorrectly rejected",()=>{
  const snap=snapshot();
  snap.constraints[0].validated=false;
  const result=evaluateCatalogIntegrity(snap);
  assert.equal(result.ok,true);
  assert.equal(result.summary.legacyNotValidated,1);
  assert.equal(result.warnings.length,1);
});
test("RLS force and policy gaps are hard blockers",()=>{
  const snap=snapshot();
  snap.rls=[{table_name:"voucher_entries",enabled:true,forced:false,policyCount:0}];
  const result=evaluateCatalogIntegrity(snap);
  assert.equal(result.ok,false);
  assert.ok(result.errors.includes("rls-not-forced:voucher_entries"));
  assert.ok(result.errors.includes("rls-missing-policy:voucher_entries"));
});
test("catalog collector is transactional read-only and never rewrites financial rows",()=>{
  const source=readFileSync(path.join(root,"scripts/audit-database-integrity-catalog.mjs"),"utf8");
  assert.match(source,/BEGIN READ ONLY/);
  assert.match(source,/ROLLBACK/);
  assert.doesNotMatch(source,/client\.query\(\s*["'`]\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
});
