/**
 * Pure comparison of a read-only PostgreSQL catalog snapshot with a
 * deliberately scoped critical-schema contract. No automatic remediation.
 */
import { criticalTables, criticalColumns, criticalIndexes } from "../server/criticalSchemaReadiness.mjs";

export const REQUIRED_CONSTRAINTS = Object.freeze([
  ["voucher_entries","voucher_entries_ledger_account_id_fkey"],
  ["voucher_entries","voucher_entries_bank_account_id_fkey"],
  ["voucher_entries","voucher_entries_amounts_non_negative"],
  ["voucher_entries","voucher_entries_single_side"],
  ["factory_fixed_production_plans","factory_fixed_production_plans_pkey"],
  ["factory_fixed_production_plans","factory_fixed_production_allocations_object"]
]);
export const REQUIRED_TRIGGERS = Object.freeze([
  ["voucher_entries","voucher_entries_balance_guard"],
  ["vouchers","vouchers_balance_guard"],
  ["voucher_entries","voucher_entries_sync_company_id"]
]);
export const PLANNER_COLUMNS = Object.freeze([
  "company_id","allocations_20t","is_locked","revision","updated_by","updated_at"
]);
export const WARNING_COLUMNS = Object.freeze([
  ["vouchers","supplier_id"],
  ["voucher_entries","supplier_id"],
  ["sp_containers","supplier_id"],
  ["sp_containers","goods_otw_voucher_id"],
  ["ledger_accounts","sub_type"],
  ["user_preferences","factory_net_position_valuation_mode"]
]);

export function compareSchemaDrift(snapshot, { includeControlled = false } = {}) {
  const expectedTables = [...criticalTables];
  const expectedColumns = [...criticalColumns];
  const expectedIndexes = [...criticalIndexes];
  const expectedConstraints = REQUIRED_CONSTRAINTS.filter(([table])=>includeControlled || table!=="factory_fixed_production_plans");
  if (includeControlled) {
    expectedTables.push("factory_fixed_production_plans","sp_containers","user_preferences");
    for(const column of PLANNER_COLUMNS) expectedColumns.push(["factory_fixed_production_plans",column]);
    expectedColumns.push(...WARNING_COLUMNS);
  }

  const tables = new Set(snapshot.tables || []);
  const columns = new Set((snapshot.columns||[]).map(x=>x.table_name+"."+x.column_name));
  const indexes = new Map((snapshot.indexes||[]).map(x=>[x.index_name,x]));
  const constraints = new Map((snapshot.constraints||[]).map(x=>[x.table_name+"."+x.constraint_name,x]));
  const triggers = new Map((snapshot.triggers||[]).map(x=>[x.table_name+"."+x.trigger_name,x]));
  const missingTables = expectedTables.filter(x=>!tables.has(x));
  const missingColumns = expectedColumns.map(([t,c])=>t+"."+c).filter(x=>!columns.has(x));
  const missingIndexes = expectedIndexes.filter(name=>!indexes.has(name));
  const invalidIndexes = expectedIndexes.filter(name=>indexes.has(name)&&
    (indexes.get(name).valid!==true||indexes.get(name).ready!==true));
  const missingConstraints = expectedConstraints.map(([t,c])=>t+"."+c).filter(x=>!constraints.has(x));
  // NOT VALID still enforces new rows. Report separately; no auto VALIDATE.
  const unvalidatedConstraints = expectedConstraints.map(([t,c])=>t+"."+c)
    .filter(x=>constraints.has(x)&&constraints.get(x).validated!==true);
  const missingTriggers = REQUIRED_TRIGGERS.map(([t,c])=>t+"."+c).filter(x=>!triggers.has(x));
  const disabledTriggers = REQUIRED_TRIGGERS.map(([t,c])=>t+"."+c)
    .filter(x=>triggers.has(x)&&!["O","A"].includes(triggers.get(x).enabled));
  const blockers={missingTables,missingColumns,missingIndexes,invalidIndexes,missingConstraints,missingTriggers,disabledTriggers};
  return {
    ok:Object.values(blockers).every(xs=>xs.length===0),
    coverage:includeControlled?"critical-plus-controlled":"critical-runtime",
    blockers,
    warnings:{unvalidatedConstraints}
  };
}

export function compareMigrationHistory(manifest, rows, historyExists) {
  const failures=[];
  const byName=new Map(manifest.map(x=>[x.name,x.checksum]));
  const names=new Set();
  for(const row of rows) {
    const name=row.migration_name;
    if(names.has(name)) failures.push("duplicate:"+name);
    names.add(name);
    if(!byName.has(name)) failures.push("unknown:"+name);
    else if(byName.get(name)!==String(row.checksum).trim()) failures.push("checksum:"+name);
  }
  const ordered=manifest.map(x=>x.name);
  const appliedFlags=ordered.map(x=>names.has(x));
  const firstMissing=appliedFlags.indexOf(false);
  if(firstMissing>=0 && appliedFlags.slice(firstMissing).some(Boolean)) failures.push("non-prefix-history");
  return {
    ok:failures.length===0,
    historyExists,
    applied:rows.length,
    pending:manifest.filter(x=>!names.has(x.name)).map(x=>x.name),
    failures
  };
}
