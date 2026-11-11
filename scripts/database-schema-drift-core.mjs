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

export const SECURITY_COLUMNS = Object.freeze(["id","user_id","company_id","permission","granted_by","created_at","updated_at"]);
export const FACTORY_CONTAINER_COLUMNS = Object.freeze(["supplier_id","origin","total_kg","rate_per_kg","declared_kg","actual_received_kg","final_payable_amount","difference_kg","currency_code","fx_rate_to_usd","fx_rate_to_usd_import","fx_rate_to_usd_offload","fx_rate_source","fx_rate_confirmed","fx_rate_date_import","fx_rate_date_offload","rate_per_kg_usd","final_payable_amount_usd","arrival_date","destination","notes","status","freight","freight_currency_code","freight_account_id","freight_supplier_id","freight_paid_by","freight_own_account_id","freight_fx_rate_to_usd","freight_fx_rate_confirmed","freight_fx_rate_date","other_charges","other_charges_currency_code","other_charges_account_id","other_charges_supplier_id","commission_amount","commission_currency_code","commission_account_id","commission_supplier_id","commission_notes","commission_fx_rate_to_usd","commission_fx_rate_confirmed","commission_fx_rate_date","duty_amount","duty_account_id","duty_status","duty_notes","pre_offload_freight","pre_offload_freight_currency_code","pre_offload_freight_account_id","pre_offload_freight_supplier_id","pre_offload_other_charges","pre_offload_other_charges_account_id","pre_offload_other_charges_supplier_id","pre_offload_status","pre_offload_commission_amount","pre_offload_commission_currency_code","pre_offload_commission_account_id","pre_offload_commission_supplier_id","pre_offload_commission_notes","deleted_at","created_at","updated_at","tracking_enabled","tracking_auto_update","tracking_carrier_hint","tracking_provider","tracking_last_status","tracking_last_location","tracking_last_checked_at","tracking_last_event_date","tracking_last_description","tracking_error","tracking_changed_at","tracking_detected_carrier","tracking_next_check_at","tracking_last_skip_reason","json_cargo_last_checked_at","json_cargo_tracking_status","json_cargo_error","otw_note","otw_docs_received"]);

export function compareSchemaDrift(snapshot, { includeControlled = false } = {}) {
  const expectedTables = [...criticalTables];
  const expectedColumns = [...criticalColumns];
  const expectedIndexes = [...criticalIndexes];
  const expectedConstraints = REQUIRED_CONSTRAINTS.filter(([table])=>includeControlled || table!=="factory_fixed_production_plans");
  if (includeControlled) {
    expectedTables.push("factory_fixed_production_plans","sp_containers","user_preferences","factory_containers","user_security_permissions");
    expectedIndexes.push("user_security_permissions_unique","user_security_permissions_company_user_idx");
    for (const name of SECURITY_COLUMNS) expectedColumns.push(["user_security_permissions",name]);
    for (const name of FACTORY_CONTAINER_COLUMNS) expectedColumns.push(["factory_containers",name]);
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
