import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fingerprintFullSchema,
  compareFullSchemaFingerprint,
} from "../scripts/database-full-schema-fingerprint-core.mjs";

function example() {
  return {
    tables: ["vouchers", "voucher_entries"],
    columns: [
      {
        table_name: "vouchers",
        column_name: "company_id",
        data_type: "integer",
        not_null: true,
        default_expression: null,
      },
      {
        table_name: "voucher_entries",
        column_name: "debit_amount",
        data_type: "numeric",
        not_null: false,
        default_expression: "0",
      },
    ],
    indexes: [
      {
        table_name: "vouchers",
        index_name: "vouchers_pkey",
        valid: true,
        ready: true,
        unique: true,
        definition: "CREATE UNIQUE INDEX vouchers_pkey ON public.vouchers USING btree (id)",
        predicate: null,
        key_columns: ["id"],
      },
    ],
    constraints: [
      {
        table_name: "vouchers",
        constraint_name: "vouchers_pkey",
        type: "p",
        validated: true,
        definition: "PRIMARY KEY (id)",
      },
    ],
    triggers: [
      {
        table_name: "voucher_entries",
        trigger_name: "voucher_entries_balance_guard",
        enabled: "O",
        definition: "CREATE TRIGGER voucher_entries_balance_guard AFTER INSERT ...",
      },
    ],
    functions: [
      {
        function_name: "erp_check",
        identity_arguments: "integer",
        definition: "CREATE FUNCTION erp_check(integer) ...",
      },
    ],
    policies: [
      {
        table_name: "vouchers",
        policy_name: "vouchers_company_scope_policy",
        enabled: true,
        forced: true,
        permissive: true,
        policy_command: "ALL",
        roles: ["public"],
        using_expression: "erp_company_scope_matches(company_id)",
        check_expression: "erp_company_scope_matches(company_id)",
      },
    ],
  };
}
test("same catalog hashes deterministically and produces an empty comparison", () => {
  const a = fingerprintFullSchema(example());
  const b = fingerprintFullSchema(example());
  assert.deepEqual(a, b);
  assert.equal(compareFullSchemaFingerprint(a, b).ok, true);
});
test("full schema comparison detects removed and unexpected objects", () => {
  const original = fingerprintFullSchema(example());
  const drift = example();
  drift.columns.pop();
  drift.tables.push("unapproved_table");
  const report = compareFullSchemaFingerprint(original, fingerprintFullSchema(drift));
  assert.equal(report.ok, false);
  assert.ok(report.blockers.includes("missing:columns:voucher_entries.debit_amount"));
  assert.ok(report.blockers.includes("unexpected:tables:unapproved_table"));
});
test("full schema comparison catches changes to index definition and RLS policy", () => {
  const original = fingerprintFullSchema(example());
  const drift = example();
  drift.indexes[0].definition = "CREATE UNIQUE INDEX vouchers_pkey ON public.vouchers USING hash (id)";
  drift.policies[0].using_expression = "true";
  const report = compareFullSchemaFingerprint(original, fingerprintFullSchema(drift));
  assert.ok(report.blockers.includes("changed:indexes:vouchers.vouchers_pkey"));
  assert.ok(report.blockers.includes("changed:policies:vouchers.vouchers_company_scope_policy"));
});
test("function signatures prevent collisions for overloaded functions", () => {
  const drift = example();
  drift.functions.push({
    function_name: "erp_check",
    identity_arguments: "text",
    definition: "CREATE FUNCTION erp_check(text) ...",
  });
  const fp = fingerprintFullSchema(drift);
  assert.equal(Object.keys(fp.objects.functions).length, 2);
});
test("invalid or incomplete baseline cannot be considered a pass", () => {
  const report = compareFullSchemaFingerprint({ formatVersion: 0 }, fingerprintFullSchema(example()));
  assert.equal(report.ok, false);
  const snapshot = fingerprintFullSchema(example());
  delete snapshot.objects.constraints;
  assert.equal(compareFullSchemaFingerprint(fingerprintFullSchema(example()), snapshot).ok, false);
});
test("duplicate catalog identities are rejected instead of overwriting evidence", () => {
  const drift = example();
  drift.indexes.push({ ...drift.indexes[0] });
  assert.throws(() => fingerprintFullSchema(drift), /Nonunique schema catalog identity/);
});
