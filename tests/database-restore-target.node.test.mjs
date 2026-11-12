import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { parseDbEndpoint, validateRestoreTarget } from "../scripts/verify-restore-target.mjs";

const source = parseDbEndpoint("postgresql://backup:secret@production.example:5432/erp_db");
const target = parseDbEndpoint("postgresql://postgres:secret@localhost:5432/erp_db_restore");

test("parsing removes credentials from reported endpoint", () => {
  assert.deepEqual(source, { hostname: "production.example", port: "5432", db: "erp_db", user: "backup" });
  assert.equal(JSON.stringify(source).includes("secret"), false);
});
test("safe isolated and empty target accepted with explicit confirmation", () => {
  const result = validateRestoreTarget({ source, target, confirmation: "ISOLATED_EMPTY_RESTORE", tableCount: 0 });
  assert.equal(result.ok, true);
});
test("production database target and missing approval are rejected", () => {
  const result = validateRestoreTarget({ source, target: source, confirmation: "", tableCount: 0 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => x.includes("confirmation")));
  assert.ok(result.errors.some((x) => x.includes("same database endpoint")));
});
test("non-empty restore targets are rejected, even with confirmation", () => {
  const result = validateRestoreTarget({ source, target, confirmation: "ISOLATED_EMPTY_RESTORE", tableCount: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => x.includes("not empty")));
});
test("disguised same endpoint via IP alias is rejected", () => {
  const alternative = parseDbEndpoint("postgres://any:secret@127.0.0.1:5432/erp_db");
  const localSource = parseDbEndpoint("postgres://another:secret@localhost:5432/erp_db");
  const result = validateRestoreTarget({
    source: localSource,
    target: alternative,
    confirmation: "ISOLATED_EMPTY_RESTORE",
    tableCount: 0,
    sourceResolvedAddresses: ["127.0.0.1"],
    targetResolvedAddresses: ["127.0.0.1"],
  });
  assert.equal(result.ok, false);
});

test("both recovery workflows refuse nonempty restore destinations", () => {
  const disposable = readFileSync(path.join(root, ".github/workflows/resilience-rehearsal.yml"), "utf8");
  const live = readFileSync(path.join(root, ".github/workflows/backup-restore-verification.yml"), "utf8");
  assert.match(disposable, /node scripts\/verify-restore-target\.mjs/);
  assert.match(disposable, /RESTORE_TARGET_CONFIRMATION=ISOLATED_EMPTY_RESTORE/);
  assert.match(live, /Refusing restore: target restore_verify already has/);
});
