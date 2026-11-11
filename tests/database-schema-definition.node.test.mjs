import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUIRED_COLUMN_SHAPES,
  REQUIRED_INDEX_SHAPES,
  REQUIRED_CONSTRAINT_SHAPES,
  REQUIRED_TRIGGER_SHAPES,
  REQUIRED_FUNCTION_SHAPES,
  REQUIRED_RLS_POLICY_TABLES,
  compareDefinitionDrift,
} from "../scripts/database-schema-definition-core.mjs";

function complete() {
  return {
    columns: REQUIRED_COLUMN_SHAPES.map((x) => ({
      table_name: x.table,
      column_name: x.column,
      data_type: x.type,
      not_null: x.notNull === true,
      default_expression: x.defaultContains || null,
    })),
    indexes: REQUIRED_INDEX_SHAPES.map((x) => ({
      table_name: x.table,
      index_name: x.name,
      unique: x.unique,
      valid: true,
      ready: true,
      key_columns: x.columns,
      definition: (x.expressionFragments || []).join(" "),
      predicate: null,
    })),
    constraints: REQUIRED_CONSTRAINT_SHAPES.map((x) => ({
      table_name: x.table,
      constraint_name: x.name,
      type: x.type,
      validated: true,
      definition: (x.fragments || []).join(" "),
    })),
    triggers: REQUIRED_TRIGGER_SHAPES.map((x) => ({
      table_name: x.table,
      trigger_name: x.name,
      enabled: "O",
      definition: x.bits.join(" ") + " EXECUTE FUNCTION " + x.functionName + "()",
    })),
    functions: REQUIRED_FUNCTION_SHAPES.map((x) => ({
      function_name: x.name,
      definition: x.fragments.join(" "),
    })),
    policies: REQUIRED_RLS_POLICY_TABLES.map((table_name) => ({
      table_name,
      enabled: true,
      forced: true,
      policy_name: table_name + "_company_scope_policy",
      policy_command: "ALL",
      permissive: true,
      roles: ["public"],
      using_expression: "erp_company_scope_matches(company_id)",
      check_expression: "erp_company_scope_matches(company_id)",
    })),
  };
}
test("reviewed object definitions accept correct schema", () => {
  const result = compareDefinitionDrift(complete());
  assert.equal(result.ok, true, result.blockers.join(", "));
});
test("type/default/nullability drift fails even if column exists", () => {
  const data = complete();
  const c = data.columns.find((x) => x.column_name === "allocations_20t");
  c.data_type = "text";
  c.not_null = false;
  c.default_expression = null;
  const result = compareDefinitionDrift(data);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("column-type:factory_fixed_production_plans.allocations_20t"));
  assert.ok(result.blockers.includes("column-nullability:factory_fixed_production_plans.allocations_20t"));
  assert.ok(result.blockers.includes("column-default:factory_fixed_production_plans.allocations_20t"));
});
test("index definition drift detects wrong uniqueness, key order and missing expression", () => {
  const data = complete();
  const i = data.indexes.find((x) => x.index_name === "user_security_permissions_unique");
  i.unique = false;
  i.key_columns = ["company_id", "user_id", "permission"];
  const e = data.indexes.find((x) => x.index_name === "factory_bale_products_company_article_code_normalized_idx");
  e.definition = "CREATE INDEX on factory_bale_products (company_id,article_code)";
  const result = compareDefinitionDrift(data);
  assert.ok(result.blockers.includes("index-uniqueness:user_security_permissions.user_security_permissions_unique"));
  assert.ok(result.blockers.includes("index-key-order:user_security_permissions.user_security_permissions_unique"));
  assert.ok(
    result.blockers.includes(
      "index-expression:factory_bale_products.factory_bale_products_company_article_code_normalized_idx"
    )
  );
});
test("wrong constraint kind and disabled trigger are blocked", () => {
  const data = complete();
  data.constraints[0].type = "f";
  data.triggers[0].enabled = "D";
  data.triggers[1].definition = "AFTER UPDATE";
  const result = compareDefinitionDrift(data);
  assert.ok(result.blockers.some((x) => x.startsWith("constraint-kind:")));
  assert.ok(result.blockers.some((x) => x.startsWith("trigger-disabled:")));
  assert.ok(result.blockers.some((x) => x.startsWith("trigger-definition:")));
});
test("functions missing critical scan timestamp behavior are not accepted", () => {
  const data = complete();
  data.functions[0].definition = "RETURN NEW";
  const result = compareDefinitionDrift(data);
  assert.ok(result.blockers.includes("function-definition:set_customer_order_bale_scanned_at"));
});
test("historical unvalidated constraints are warnings while definitions remain intact", () => {
  const data = complete();
  data.constraints[0].validated = false;
  const result = compareDefinitionDrift(data);
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
});

test("RLS disabled or wrong tenant predicate is detected even if named policy exists", () => {
  const data = complete();
  const p = data.policies.find((x) => x.table_name === "vouchers");
  p.enabled = false;
  p.check_expression = "true";
  const report = compareDefinitionDrift(data);
  assert.equal(report.ok, false);
  assert.ok(report.blockers.includes("rls-disabled:vouchers"));
  assert.ok(report.blockers.includes("rls-policy-definition:vouchers"));
});
test("missing tenant policy and unexpected role restrictions fail closed", () => {
  const data = complete();
  data.policies = data.policies.filter((x) => x.table_name !== "inventory");
  data.policies[0].roles = ["erp_user"];
  const report = compareDefinitionDrift(data);
  assert.ok(report.blockers.includes("rls-table-missing:inventory"));
  assert.ok(report.blockers.some((x) => x.startsWith("rls-policy-roles:")));
});
