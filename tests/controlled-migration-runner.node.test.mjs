import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "scripts/run-controlled-migrations.mjs");
const invoke = (args, env = {}) => spawnSync(process.execPath, [runner, ...args], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, DATABASE_URL: "", MIGRATION_CONFIRMATION: "", ...env }
});

test("plan inventories new migration folder without PostgreSQL", () => {
  const result = invoke(["--plan"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "plan");
  assert.equal(report.databaseAccess, false);
  assert.ok(Array.isArray(report.migrations));
});

test("refuses implicit apply and ambiguous modes", () => {
  for (const args of [[], ["--plan","--apply"], ["--unknown"]]) {
    const result = invoke(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Select exactly one/i);
  }
});

test("apply requires explicit one-time confirmation before connecting", () => {
  const result = invoke(["--apply"], { DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Apply denied/);
});

test("status requires database but never initiates migration with no URL", () => {
  const result = invoke(["--status"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL is required/);
});

test("production app startup does not import the controlled runner", () => {
  const files = ["server/startupPreload.mjs","server/schemaPreload.mjs","render.yaml"];
  for (const file of files) {
    assert.doesNotMatch(readFileSync(path.join(root,file),"utf8"), /run-controlled-migrations/);
  }
});
