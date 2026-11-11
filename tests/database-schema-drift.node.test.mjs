import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSchemaDrift, compareMigrationHistory, REQUIRED_CONSTRAINTS, REQUIRED_TRIGGERS } from "../scripts/database-schema-drift-core.mjs";
import { criticalTables, criticalColumns, criticalIndexes } from "../server/criticalSchemaReadiness.mjs";

function completeSnapshot() {
  return {
    tables:[...criticalTables],
    columns:criticalColumns.map(([table_name,column_name])=>({table_name,column_name})),
    indexes:criticalIndexes.map(index_name=>({index_name,valid:true,ready:true})),
    constraints:REQUIRED_CONSTRAINTS.filter(([t])=>t!=="factory_fixed_production_plans").map(([table_name,constraint_name])=>({table_name,constraint_name,validated:true})),
    triggers:REQUIRED_TRIGGERS.map(([table_name,trigger_name])=>({table_name,trigger_name,enabled:"O"}))
  };
}
test("valid critical schema reports no drift",()=>{
  const s=compareSchemaDrift(completeSnapshot());
  assert.equal(s.ok,true);
  assert.equal(s.coverage,"critical-runtime");
});
test("missing columns, invalid indexes and disabled triggers fail closed",()=>{
  const snapshot=completeSnapshot();
  snapshot.columns.shift();
  snapshot.indexes[0].valid=false;
  snapshot.triggers[0].enabled="D";
  const result=compareSchemaDrift(snapshot);
  assert.equal(result.ok,false);
  assert.equal(result.blockers.missingColumns.length,1);
  assert.equal(result.blockers.invalidIndexes.length,1);
  assert.equal(result.blockers.disabledTriggers.length,1);
});
test("unvalidated historical constraints are warnings, not silent acceptance",()=>{
  const snapshot=completeSnapshot();
  snapshot.constraints[0].validated=false;
  const result=compareSchemaDrift(snapshot);
  assert.equal(result.ok,true);
  assert.equal(result.warnings.unvalidatedConstraints.length,1);
});
test("strict controlled mode requires planner and startup-warning objects",()=>{
  const result=compareSchemaDrift(completeSnapshot(),{includeControlled:true});
  assert.equal(result.ok,false);
  assert.ok(result.blockers.missingTables.includes("factory_fixed_production_plans"));
  assert.ok(result.blockers.missingColumns.includes("sp_containers.supplier_id"));
});
test("migration history catches edited, unknown, and out-of-order entries",()=>{
  const m=[{name:"20261111_001_a.sql",checksum:"a"},{name:"20261111_002_b.sql",checksum:"b"}];
  assert.equal(compareMigrationHistory(m,[],false).ok,true);
  assert.deepEqual(compareMigrationHistory(m,[],false).pending,m.map(x=>x.name));
  assert.equal(compareMigrationHistory(m,[{migration_name:m[0].name,checksum:"a"}],true).ok,true);
  const changed=compareMigrationHistory(m,[{migration_name:m[0].name,checksum:"wrong"}],true);
  assert.ok(changed.failures.some(x=>x.startsWith("checksum:")));
  const outOfOrder=compareMigrationHistory(m,[{migration_name:m[1].name,checksum:"b"}],true);
  assert.ok(outOfOrder.failures.includes("non-prefix-history"));
  assert.ok(compareMigrationHistory(m,[{migration_name:"unknown.sql",checksum:"a"}],true).failures.includes("unknown:unknown.sql"));
});

test("controlled schema drift catches missing security and Factory container objects",()=>{
  const result=compareSchemaDrift(completeSnapshot(),{includeControlled:true});
  assert.ok(result.blockers.missingTables.includes("user_security_permissions"));
  assert.ok(result.blockers.missingColumns.includes("user_security_permissions.permission"));
  assert.ok(result.blockers.missingColumns.includes("factory_containers.tracking_next_check_at"));
  assert.ok(result.blockers.missingIndexes.includes("user_security_permissions_unique"));
});
