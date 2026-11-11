/**
 * Phase 4: read-only integrity catalog coverage.
 * Legacy NOT VALID constraints enforce NEW writes but leave historical rows
 * unchecked. Treat them as warnings, never silently validate or delete rows.
 */
export const CORE_TABLES = Object.freeze([
  "companies","vouchers","voucher_entries","ledger_accounts","bank_accounts",
  "fixed_assets","stock_adjustment_vouchers","stock_adjustment_items"
]);
export const REQUIRED_RLS_TABLES = Object.freeze([
  "vouchers","customers","ledger_accounts","bank_accounts","fixed_assets",
  "stock_groups","stock_items","inventory","voucher_entries"
]);
export const CONTROL_TABLES = Object.freeze([
  "user_company_roles","user_locations","user_location_cash_accounts",
  "role_feature_permissions","user_security_permissions","locations","users"
]);
export const CORE_CONSTRAINTS = Object.freeze([
  ["voucher_entries","voucher_entries_ledger_account_id_fkey"],
  ["voucher_entries","voucher_entries_bank_account_id_fkey"],
  ["voucher_entries","voucher_entries_fixed_asset_id_fkey"],
  ["voucher_entries","voucher_entries_amounts_non_negative"],
  ["voucher_entries","voucher_entries_single_side"],
  ["ledger_accounts","ledger_accounts_parent_id_fkey"]
]);
export const CONTROL_CONSTRAINTS = Object.freeze([
  ["user_company_roles","user_company_roles_user_fk"],
  ["user_company_roles","user_company_roles_company_fk"],
  ["user_locations","user_locations_user_fk"],
  ["user_locations","user_locations_company_fk"],
  ["user_location_cash_accounts","user_location_cash_accounts_user_fk"],
  ["user_location_cash_accounts","user_location_cash_accounts_company_fk"],
  ["role_feature_permissions","role_feature_permissions_company_fk"],
  ["user_security_permissions","user_security_permissions_company_fk"]
]);
export const CORE_TRIGGERS = Object.freeze([
  ["voucher_entries","voucher_entries_balance_guard"],
  ["vouchers","vouchers_balance_guard"],
  ["vouchers","vouchers_balance_guard_history_marker"],
  ["stock_adjustment_vouchers","stock_adjustment_vouchers_balance_guard"],
  ["stock_adjustment_items","stock_adjustment_items_balance_guard"],
  ["voucher_entries","voucher_entries_sync_company_id"],
  ["voucher_entries","voucher_entries_target_guard"],
  ["ledger_accounts","ledger_accounts_tree_guard"]
]);
export const CONTROL_TRIGGERS = Object.freeze([
  ["user_company_roles","user_company_roles_tenant_guard"],
  ["user_locations","user_locations_tenant_guard"],
  ["user_location_cash_accounts","user_location_cash_accounts_tenant_guard"],
  ["locations","locations_tenant_control_parent_guard"],
  ["ledger_accounts","ledger_accounts_tenant_control_parent_guard"]
]);
const key=(t,c)=>t+"."+c;

/** An empty catalog is NOT a pass. If an optional table exists, all its guards become required. */
export function evaluateCatalogIntegrity(snapshot) {
  const tables=new Set(snapshot.tables||[]);
  const constraints=new Map((snapshot.constraints||[]).map(x=>[key(x.table_name,x.constraint_name),x]));
  const triggers=new Map((snapshot.triggers||[]).map(x=>[key(x.table_name,x.trigger_name),x]));
  const errors=[];
  const warnings=[];
  const requiredTables=[...new Set([...CORE_TABLES,...CONTROL_TABLES,...REQUIRED_RLS_TABLES])];
  const summary={requiredTables:requiredTables.length,availableTables:tables.size,expectedConstraints:0,expectedTriggers:0,legacyNotValidated:0};
  for(const t of requiredTables) if(!tables.has(t))errors.push("missing-table:"+t);
  const allConstraints=[...CORE_CONSTRAINTS,...CONTROL_CONSTRAINTS.filter(([t])=>tables.has(t))];
  const allTriggers=[...CORE_TRIGGERS,...CONTROL_TRIGGERS.filter(([t])=>tables.has(t))];
  for(const [t,c] of allConstraints) {
    if(!tables.has(t)) continue;
    summary.expectedConstraints++;
    const found=constraints.get(key(t,c));
    if(!found)errors.push("missing-constraint:"+key(t,c));
    else if(found.validated!==true){
      warnings.push("not-valid-legacy-constraint:"+key(t,c));
      summary.legacyNotValidated++;
    }
  }
  for(const [t,c] of allTriggers) {
    if(!tables.has(t)) continue;
    summary.expectedTriggers++;
    const found=triggers.get(key(t,c));
    if(!found)errors.push("missing-trigger:"+key(t,c));
    else if(!["O","A"].includes(found.enabled))errors.push("disabled-trigger:"+key(t,c));
  }
  // Company scope is critical: every present RLS protected table must retain
  // FORCE RLS as well as a policy. No automatic enable or policy replacement.
  const rlsByTable=new Map((snapshot.rls||[]).map(x=>[x.table_name,x]));
  for(const table of REQUIRED_RLS_TABLES) {
    if(!tables.has(table)) continue;
    const t=rlsByTable.get(table);
    if(!t || !t.enabled)errors.push("rls-disabled:"+table);
    if(!t || !t.forced)errors.push("rls-not-forced:"+table);
    if(!t || !t.policyCount)errors.push("rls-missing-policy:"+table);
  }
  // Noncanonical RLS relations are included as a hardening signal, but the
  // required-list above is what prevents fully disabled RLS from disappearing.
  for(const t of snapshot.rls||[]) {
    if(REQUIRED_RLS_TABLES.includes(t.table_name)) continue;
    if(t.enabled && !t.policyCount)warnings.push("rls-custom-table-no-policy:"+t.table_name);
  }
  return {ok:errors.length===0,mode:"catalog-read-only",summary,errors,warnings};
}
