/**
 * Phase 5: contract-level PostgreSQL drift, checked in addition to object names.
 * All contracts are intentionally explicit; never infer "expected" definitions
 * from the same live catalog being audited. No database writes are performed.
 *
 * Definitions are compared semantically for critical controlled schema paths,
 * not as a fragile exact pg_get_* string equality across PostgreSQL versions.
 */
export const REQUIRED_COLUMN_SHAPES=Object.freeze([
  {table:"factory_fixed_production_plans",column:"company_id",type:"integer",notNull:true},
  {table:"factory_fixed_production_plans",column:"allocations_20t",type:"jsonb",notNull:true,defaultContains:"{}"},
  {table:"factory_fixed_production_plans",column:"is_locked",type:"boolean",notNull:true,defaultContains:"false"},
  {table:"factory_fixed_production_plans",column:"revision",type:"integer",notNull:true,defaultContains:"1"},
  {table:"factory_fixed_production_plans",column:"updated_at",type:"timestamp with time zone",notNull:true,defaultContains:"now()"},
  {table:"user_security_permissions",column:"user_id",type:"character varying",notNull:true},
  {table:"user_security_permissions",column:"company_id",type:"integer",notNull:true},
  {table:"user_security_permissions",column:"permission",type:"text",notNull:true},
  {table:"customer_order_bales",column:"scanned_at",type:"timestamp with time zone"},
  {table:"customer_order_bales_history",column:"scanned_at",type:"timestamp with time zone"},
  {table:"factory_categories",column:"name_ar",type:"character varying"},
  {table:"factory_bale_products",column:"name_ar",type:"text"},
  {table:"factory_categories",column:"name_fr",type:"character varying"},
  {table:"factory_bale_products",column:"name_fr",type:"text"}
]);
export const REQUIRED_INDEX_SHAPES=Object.freeze([
  {table:"exchange_rates",name:"exchange_rates_company_date_pair_unique",unique:true,
    columns:["company_id","effective_date","from_currency","to_currency"]},
  {table:"user_security_permissions",name:"user_security_permissions_unique",unique:true,
    columns:["user_id","company_id","permission"]},
  {table:"user_security_permissions",name:"user_security_permissions_company_user_idx",unique:false,
    columns:["company_id","user_id"]},
  {table:"factory_bale_products",name:"factory_bale_products_company_article_code_normalized_idx",
    unique:false,columns:["company_id"],expressionFragments:["upper","btrim","article_code"]}
]);
export const REQUIRED_CONSTRAINT_SHAPES=Object.freeze([
  {table:"factory_fixed_production_plans",name:"factory_fixed_production_allocations_object",type:"c",
    fragments:["jsonb_typeof","allocations_20t","object"]},
  {table:"factory_fixed_production_plans",name:"factory_fixed_production_plans_pkey",type:"p"},
  {table:"voucher_entries",name:"voucher_entries_amounts_non_negative",type:"c",
    fragments:["debit_amount","credit_amount"]},
  {table:"voucher_entries",name:"voucher_entries_single_side",type:"c",
    fragments:["debit_amount","credit_amount"]}
]);
export const REQUIRED_TRIGGER_SHAPES=Object.freeze([
  {table:"customer_order_bales",name:"customer_order_bales_set_scanned_at",
    functionName:"set_customer_order_bale_scanned_at",bits:["BEFORE INSERT","FOR EACH ROW"]},
  {table:"customer_order_bales_history",name:"customer_order_bales_history_copy_scanned_at",
    functionName:"copy_customer_order_bale_scanned_at_to_history",bits:["BEFORE INSERT","FOR EACH ROW"]}
]);
export const REQUIRED_FUNCTION_SHAPES=Object.freeze([
  {name:"set_customer_order_bale_scanned_at",fragments:[
    "NEW.scanned_at","NEW.scanned_by","CURRENT_TIMESTAMP","customer_order_bales_history"]},
  {name:"copy_customer_order_bale_scanned_at_to_history",fragments:[
    "NEW.scanned_at","NEW.original_id","customer_order_bales"]}
]);
const normalized=x=>String(x??"").toLowerCase().replace(/["']/g,"").replace(/\s+/g," ").trim();
const includesAll=(value,fragments)=>fragments.every(f=>normalized(value).includes(normalized(f)));
const key=(t,n)=>t+"."+n;

export function compareDefinitionDrift(snapshot) {
  const columns=new Map((snapshot.columns||[]).map(x=>[key(x.table_name,x.column_name),x]));
  const indexes=new Map((snapshot.indexes||[]).map(x=>[key(x.table_name,x.index_name),x]));
  const constraints=new Map((snapshot.constraints||[]).map(x=>[key(x.table_name,x.constraint_name),x]));
  const triggers=new Map((snapshot.triggers||[]).map(x=>[key(x.table_name,x.trigger_name),x]));
  const functions=new Map((snapshot.functions||[]).map(x=>[x.function_name,x]));
  const blockers=[];
  const warnings=[];
  for(const c of REQUIRED_COLUMN_SHAPES) {
    const item=key(c.table,c.column),actual=columns.get(item);
    if(!actual) {blockers.push("column-missing:"+item);continue;}
    if(normalized(actual.data_type)!==normalized(c.type)) blockers.push("column-type:"+item);
    if(c.notNull===true && actual.not_null!==true) blockers.push("column-nullability:"+item);
    if(c.defaultContains && !includesAll(actual.default_expression,[c.defaultContains]))
      blockers.push("column-default:"+item);
  }
  for(const c of REQUIRED_INDEX_SHAPES) {
    const item=key(c.table,c.name),actual=indexes.get(item);
    if(!actual) {blockers.push("index-missing:"+item);continue;}
    if(actual.valid!==true || actual.ready!==true) blockers.push("index-invalid:"+item);
    if(actual.unique!==c.unique) blockers.push("index-uniqueness:"+item);
    const indexed=actual.key_columns||[];
    if(c.columns.some((col,i)=>normalized(indexed[i])!==normalized(col)))
      blockers.push("index-key-order:"+item);
    if(c.expressionFragments && !includesAll(actual.definition,c.expressionFragments))
      blockers.push("index-expression:"+item);
    if(actual.predicate)blockers.push("index-unexpected-partial-predicate:"+item);
  }
  for(const c of REQUIRED_CONSTRAINT_SHAPES) {
    const item=key(c.table,c.name),actual=constraints.get(item);
    if(!actual){blockers.push("constraint-missing:"+item);continue;}
    if(actual.type!==c.type)blockers.push("constraint-kind:"+item);
    if(c.fragments && !includesAll(actual.definition,c.fragments))
      blockers.push("constraint-definition:"+item);
    if(actual.validated!==true)warnings.push("constraint-not-validated:"+item);
  }
  for(const c of REQUIRED_TRIGGER_SHAPES) {
    const item=key(c.table,c.name),actual=triggers.get(item);
    if(!actual){blockers.push("trigger-missing:"+item);continue;}
    if(!["O","A"].includes(actual.enabled))blockers.push("trigger-disabled:"+item);
    if(!includesAll(actual.definition,[...c.bits,c.functionName]))
      blockers.push("trigger-definition:"+item);
  }
  for(const f of REQUIRED_FUNCTION_SHAPES) {
    const actual=functions.get(f.name);
    if(!actual){blockers.push("function-missing:"+f.name);continue;}
    if(!includesAll(actual.definition,f.fragments))
      blockers.push("function-definition:"+f.name);
  }
  return {
    ok:blockers.length===0,
    coverage:"reviewed-controlled-schema-definition-subset",
    blockers,warnings,
    note:"Semantic fragments detect critical changes but are not a byte-for-byte function/constraint equivalence proof."
  };
}
