import assert from "node:assert/strict";
import { test } from "node:test";
import { assessReleaseEvidence, requiredReleaseChecks } from "../scripts/database-phase9-release-core.mjs";
const sha="a".repeat(40);
const now=new Date("2026-11-11T08:00:00.000Z");
const stamp="2026-11-11T07:30:00.000Z";
const url="https://github.com/example/repo/actions/runs/123";
const proof=()=>({passed:true,evidenceUrl:url,checkedAt:stamp,commit:sha});
function fullEvidence() {
  return {
    schemaVersion:1,
    release:{commit:sha,environment:"production",migrationStrategy:"manual-approved",evaluatedAt:stamp},
    backup:{sha256:"b".repeat(64),sizeBytes:102400,
      createdAt:stamp,verifiedRestoreUrl:url,
      measuredRpoMinutes:10,approvedRpoMinutes:30,
      measuredRtoMinutes:25,approvedRtoMinutes:60},
    checks:Object.fromEntries(requiredReleaseChecks.map(x=>[x,proof()])),
    approvals:Object.fromEntries(["databaseOwner","accountingOwner","releaseOwner"].map(x=>[x,{
      approved:true,recordUrl:url,approver:"authorized-reviewer",approvedAt:"2026-11-11T07:45:00.000Z"
    }])),
    safety:{noAutomaticMigration:true,noAccountingDataRewrite:true,
      previousDeploymentRetained:true,stagingHasNoExternalSchedulers:true}
  };
}
const check=e=>assessReleaseEvidence(e,{commit:sha,now});

test("no evidence blocks production release without performing any action",()=>{
  const result=check(null);
  assert.equal(result.ok,false);
  assert.ok(result.blockers.length>=10);
});
test("complete documented evidence clears format gate, not human verification",()=>{
  const result=check(fullEvidence());
  assert.equal(result.ok,true,result.blockers.join("; "));
  assert.match(result.note,/human must verify/);
});
test("every critical independent proof blocks release when absent",()=>{
  for(const name of requiredReleaseChecks) {
    const e=fullEvidence();
    delete e.checks[name];
    const result=check(e);
    assert.equal(result.ok,false,name);
    assert.ok(result.blockers.some(x=>x.includes(name)),name);
  }
});
test("wrong commit or stale proof prevents release",()=>{
  const e=fullEvidence();
  e.checks.financialParity.commit="c".repeat(40);
  assert.equal(check(e).ok,false);
  const stale=fullEvidence();
  stale.backup.createdAt="2026-11-01T00:00:00.000Z";
  assert.equal(check(stale).ok,false);
  const future=fullEvidence();
  future.checks.tenantIsolation.checkedAt="2026-11-12T00:00:00.000Z";
  assert.equal(check(future).ok,false);
});
test("RPO/RTO exceedance and missing approvals block release",()=>{
  const e=fullEvidence();
  e.backup.measuredRpoMinutes=31;
  e.backup.measuredRtoMinutes=61;
  delete e.approvals.accountingOwner;
  const result=check(e);
  assert.equal(result.ok,false);
  assert.ok(result.blockers.some(x=>x.includes("recovery point")));
  assert.ok(result.blockers.some(x=>x.includes("recovery time")));
  assert.ok(result.blockers.some(x=>x.includes("accountingOwner")));
});
test("automatic migrations or data rewrite never pass release gate",()=>{
  const e=fullEvidence();
  e.safety.noAutomaticMigration=false;
  e.safety.noAccountingDataRewrite=false;
  assert.equal(check(e).ok,false);
});
