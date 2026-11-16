/**
 * Phase 9 evidence checks. Pure functions; never connect to a database
 * or invoke any deploy/restore/migration action.
 */
const SHA=/^[a-f0-9]{40}$/;
const HEX64=/^[a-f0-9]{64}$/;
const APPROVALS=["databaseOwner","accountingOwner","releaseOwner"];
const REQUIRED_PROOFS=[
  "controlledMigrationTests","fullSchemaDrift","accountingIntegrity",
  "tenantIsolation","legacyMigrationReconciliation","startupReadOnly",
  "stagingMigrationRehearsal","stagingRestore","financialParity",
  "factoryInventoryParity","readinessSmoke","rollbackRehearsal"
];
const isProof = p=> p && p.passed===true &&
  typeof p.evidenceUrl==="string" && /^https:\/\//.test(p.evidenceUrl) &&
  typeof p.checkedAt==="string" && Number.isFinite(Date.parse(p.checkedAt));

export function assessReleaseEvidence(e,{commit,now=new Date(),maxAgeHours=24}={}) {
  const blockers=[];
  const requireField=(condition,message)=>{if(!condition) blockers.push(message);};
  requireField(SHA.test(commit||""),"Exact 40-character release commit SHA required");
  requireField(e && e.schemaVersion===1,"Unsupported/missing evidence schema version");
  requireField(e?.release?.commit===commit,"Evidence release commit differs from target commit");
  requireField(e?.release?.environment==="production","Evidence must target production cutover");
  requireField(e?.release?.migrationStrategy==="manual-approved","Only independently approved manual migration is supported");
  const nowMs=now instanceof Date?now.getTime():Number(new Date(now));
  const issued=Date.parse(e?.release?.evaluatedAt||"");
  requireField(Number.isFinite(issued) && issued<=nowMs && nowMs-issued<=maxAgeHours*3600000,
    "Release evidence missing, stale or future-dated");
  const backup=e?.backup||{};
  requireField(HEX64.test(backup.sha256||""),"Recent backup SHA-256 evidence required");
  requireField(Number.isSafeInteger(backup.sizeBytes)&&backup.sizeBytes>10240,"Backup size evidence invalid");
  const backupAt=Date.parse(backup.createdAt||"");
  requireField(Number.isFinite(backupAt)&&backupAt<=nowMs&&nowMs-backupAt<=maxAgeHours*3600000,
    "Production backup evidence missing or older than release window");
  requireField(typeof backup.verifiedRestoreUrl==="string"&&/^https:\/\//.test(backup.verifiedRestoreUrl),
    "Isolated production-sized restore evidence URL required");
  requireField(Number.isFinite(backup.measuredRpoMinutes)&&backup.measuredRpoMinutes>=0 &&
    Number.isFinite(backup.approvedRpoMinutes)&&backup.approvedRpoMinutes>=0 &&
    backup.measuredRpoMinutes<=backup.approvedRpoMinutes,"Measured recovery point exceeds approved limit");
  requireField(Number.isFinite(backup.measuredRtoMinutes)&&backup.measuredRtoMinutes>=0 &&
    Number.isFinite(backup.approvedRtoMinutes)&&backup.approvedRtoMinutes>=0 &&
    backup.measuredRtoMinutes<=backup.approvedRtoMinutes,"Measured recovery time exceeds approved limit");

  for(const key of REQUIRED_PROOFS) {
    const proof=e?.checks?.[key];
    requireField(isProof(proof),"Required verified release check missing/failing: "+key);
    if(isProof(proof)) {
      const checked=Date.parse(proof.checkedAt);
      requireField(checked<=nowMs&&nowMs-checked<=maxAgeHours*3600000,
        "Release check is stale or future-dated: "+key);
      requireField(proof.commit===commit,
        "Release check is not tied to exact commit: "+key);
    }
  }
  for(const name of APPROVALS) {
    const approval=e?.approvals?.[name];
    requireField(approval?.approved===true &&
      typeof approval?.recordUrl==="string" && /^https:\/\//.test(approval.recordUrl) &&
      typeof approval?.approver==="string" && approval.approver.trim().length>0 &&
      Number.isFinite(Date.parse(approval?.approvedAt||"")) &&
      Date.parse(approval.approvedAt)<=nowMs &&
      Date.parse(approval.approvedAt)>=issued,
      "Independent documented approval missing: "+name);
  }
  requireField(e?.safety?.noAutomaticMigration===true,"Automatic production migrations must stay disabled");
  requireField(e?.safety?.noAccountingDataRewrite===true,"Financial records must remain unchanged during schema rollout");
  requireField(e?.safety?.previousDeploymentRetained===true,"Prior deployment must remain available");
  requireField(e?.safety?.stagingHasNoExternalSchedulers===true,"Staging schedulers/external integrations must be disabled");

  return {ok:blockers.length===0,mode:"read-only-evidence-review",commit,blockers,
    note:"A passing report validates the supplied evidence format and freshness, not its authenticity; a human must verify links and approvals before any production action."};
}
export const requiredReleaseChecks=Object.freeze([...REQUIRED_PROOFS]);
