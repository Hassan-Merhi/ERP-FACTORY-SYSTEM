import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEnvExamplePolicy } from "../scripts/lib/env-example-policy.mjs";
import { CLEAN_MAINTENANCE_SCRIPTS, inspectCleanMaintenanceScripts } from "../scripts/verify-clean-maintenance-types.mjs";

test("environment examples reject duplicate declarations even when commented", () => {
  const result = checkEnvExamplePolicy({ ".env.example": "# ACTIVE=1\n# ACTIVE=0\n" });
  assert.match(result.failures.join("\n"), /duplicate ACTIVE/);
});

test("environment examples reject retired one-time repair flags", () => {
  const result = checkEnvExamplePolicy({ ".env.example": "# ERP_REWORK_POS_JNAH_VOUCHERS_20261109=0\n" });
  assert.match(result.failures.join("\n"), /retired flag/);
});

test("legitimate repeated key in different subsystem examples is allowed", () => {
  const result = checkEnvExamplePolicy({
    ".env.example": "# SHARED_KEY=1\n",
    "docs/feature.env.example": "# SHARED_KEY=1\n",
  });
  assert.deepEqual(result.failures, []);
});

test("example comments without assignments are ignored", () => {
  const result = checkEnvExamplePolicy({ ".env.example": "# Keep ERP_REWORK_POS_JNAH_VOUCHERS_20261109 retired.\n" });
  assert.deepEqual(result.failures, []);
});

test("maintenance script gate detects new any type syntax", () => {
  const outputs = inspectCleanMaintenanceScripts(() => "const value: any = 1;\n");
  assert.equal(outputs.length, CLEAN_MAINTENANCE_SCRIPTS.length);
  assert.match(outputs[0], /type escapes/);
});

test("maintenance script gate accepts valid strict types", () => {
  assert.deepEqual(inspectCleanMaintenanceScripts(() => "const value: unknown = 1;\n"), []);
});

test("maintenance script gate fails closed if a file disappears", () => {
  const outputs = inspectCleanMaintenanceScripts(() => { throw new Error("missing fixture"); });
  assert.equal(outputs.length, CLEAN_MAINTENANCE_SCRIPTS.length);
});
