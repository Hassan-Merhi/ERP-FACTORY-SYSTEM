import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();
const original = fs.readFileSync(path.join(root, "scripts/verify-semantic-filename-policy.mjs"), "utf8");
const mandatoryWorkflows = [
  "edge-phase3-validate-once.yml",
  "factory-blue-theme-phase5.yml",
  "offline-phase5-acceptance.yml",
  "offline-phase5-check.yml",
  "offline-phase6-contract.yml",
  "offline-phase7-contract.yml",
  "offline-phase8-contract.yml",
  "offline-phase9-contract.yml",
];
const mandatoryConfig = [
  "config/i18n-phase14-baseline.json",
  "config/i18n-phase9-final-release.json",
  "vitest.config.phase9.ts",
  "deploy/lan/offline-phase6-evidence.example.json",
  "deploy/lan/phase7-install-writer-fence.sql",
  "deploy/lan/phase7-prepare-restricted-role.sql",
];

function write(dir, file, text = "") {
  const dest = path.join(dir, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
}
function shell(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" });
}
function verify(dir) {
  return spawnSync(process.execPath, ["scripts/verify-semantic-filename-policy.mjs"], {
    cwd: dir, encoding: "utf8",
  });
}
function withFixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-name-policy-"));
  try {
    write(dir, "scripts/verify-semantic-filename-policy.mjs", original);
    write(dir, "config/semantic-filename-exceptions.json", JSON.stringify({ serverTestPaths: [] }));
    for (const name of mandatoryWorkflows) write(dir, ".github/workflows/" + name, "name: preserved workflow\n");
    for (const name of mandatoryConfig) write(dir, name, "");
    assert.equal(shell(dir, ["init", "-q"]).status, 0);
    assert.equal(shell(dir, ["add", "-A"]).status, 0);
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("numbered historical migration and explicitly approved workflow names are allowed", () => {
  withFixture(dir => {
    write(dir, "migrations/0001_phase7_baseline.sql", "-- historical SQL");
    assert.equal(shell(dir, ["add", "-A"]).status, 0);
    const result = verify(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

test("new numbered runtime source fails the naming gate", () => {
  withFixture(dir => {
    write(dir, "server/phase99UnreviewedModule.ts", "export const ready = true;\n");
    assert.equal(shell(dir, ["add", "-A"]).status, 0);
    const result = verify(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NUMBERED_ACTIVE_FILENAME.*server\/phase99UnreviewedModule\.ts/);
  });
});

test("unreviewed numbered backend tests also fail", () => {
  withFixture(dir => {
    write(dir, "server/routes/phase77NewRoutes.test.ts", "export {};\n");
    assert.equal(shell(dir, ["add", "-A"]).status, 0);
    const result = verify(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NUMBERED_ACTIVE_FILENAME.*server\/routes\/phase77NewRoutes\.test\.ts/);
  });
});

test("nonexistent workflow entrypoint causes a failing check", () => {
  withFixture(dir => {
    write(dir, ".github/workflows/executable-contract.yml", "name: check\njobs:\n  check:\n    steps:\n      - run: node scripts/removed-phase9-command.mjs\n");
    assert.equal(shell(dir, ["add", "-A"]).status, 0);
    const result = verify(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DANGLING_ENTRYPOINT_REFERENCE.*scripts\/removed-phase9-command\.mjs/);
  });
});

test("persisted environment and database identifiers remain stable after filename changes", () => {
  const read = p => fs.readFileSync(path.join(root, p), "utf8");
  const inventory = read("server/inventoryValuationGuardedRepair.mjs");
  const salesIndex = read("server/salesHotpathIndexRepair.mjs");
  const writerGate = read("server/edge/writerGate.mjs");
  assert.match(inventory, /INVENTORY_VALUATION_WAVE6_REPAIR/);
  assert.match(inventory, /erp\.inventory-valuation-wave6-repair\.applied/);
  assert.match(salesIndex, /RUN_WAVE3_INDEX_REPAIR/);
  assert.match(writerGate, /phase7_writer\.state/);
  assert.match(read("server/companyScopeRlsBridge.mjs"), /inventoryValuationGuardedRepair\.mjs/);
  assert.match(read("server/startupPreload.mjs"), /salesHotpathIndexRepair\.mjs/);
});
