import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { comparePhase7Baselines, PHASE7_BASELINE_PROTOCOL } from "../scripts/edge/audit-phase7-baseline.mjs";

const sha = "a".repeat(64);
const input = {
  protocol: PHASE7_BASELINE_PROTOCOL,
  snapshotSha256: sha,
  schemaSha256: "b".repeat(64),
  tables: [{ name: "public.vouchers", rows: 12, sha256: "c".repeat(64) }],
  sequences: [{ name: "public.vouchers_id_seq", lastValue: "15", isCalled: true }],
  uploads: { files: 2, bytes: 50, sha256: "d".repeat(64) },
};

test("separately scoped matching clone fingerprints compare", () => {
  assert.deepEqual(comparePhase7Baselines({ ...input, scope: "source" }, { ...input, scope: "restore" }), {
    tables: 1, sequences: 1, uploads: 2,
  });
});

test("mismatched data, schema, snapshots, sequences and uploads fail closed", () => {
  for (const patch of [
    { snapshotSha256: "e".repeat(64) },
    { schemaSha256: "e".repeat(64) },
    { tables: [{ ...input.tables[0], rows: 13 }] },
    { sequences: [{ ...input.sequences[0], lastValue: "14" }] },
    { uploads: { ...input.uploads, sha256: "e".repeat(64) } },
  ]) {
    assert.throws(
      () => comparePhase7Baselines({ ...input, scope: "source" }, { ...input, ...patch, scope: "restore" }),
      /PHASE7_BASELINE_(SNAPSHOT|SCHEMA|TABLES|SEQUENCES|UPLOADS)_MISMATCH/
    );
  }
});

test("bad evidence, duplication and swapped trust roles are rejected", () => {
  for (const patch of [
    { snapshotSha256: "not-a-hash" },
    { tables: [...input.tables, ...input.tables] },
    { tables: [...input.tables, { ...input.tables[0], name: "public.accounts" }] },
    { sequences: [{ ...input.sequences[0], isCalled: "true" }] },
    { uploads: { ...input.uploads, bytes: -1 } },
    { scope: "restore" },
  ]) {
    assert.throws(
      () => comparePhase7Baselines({ ...input, ...patch, scope: patch.scope ?? "source" }, {
        ...input, scope: "restore",
      }), /PHASE7_BASELINE_/
    );
  }
});

test("compare CLI refuses missing files and accepts valid private evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase7-baseline-"));
  try {
    const source = join(dir, "source.json");
    const restore = join(dir, "restored.json");
    await writeFile(source, JSON.stringify({ ...input, scope: "source" }));
    await writeFile(restore, JSON.stringify({ ...input, scope: "restore" }));
    const command = "scripts/edge/audit-phase7-baseline.mjs";
    const ok = spawnSync(process.execPath, [command, "compare", source, restore], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /PHASE7_BASELINE_COMPARE_OK/);
    const denied = spawnSync(process.execPath, [command, "compare", source, "/missing.json"], { encoding: "utf8" });
    assert.notEqual(denied.status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
