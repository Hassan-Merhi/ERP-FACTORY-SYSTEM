import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hasVerifiedPhase7WriterAuthority,
  isVerifiedPhase7WriterRow,
} from "../server/edge/phase7WriterGate.mjs";
import { readFactoryEdgeConfiguration } from "../server/edge/edgeRuntimePolicy.mjs";

const siteId = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const baselineSha256 = "a".repeat(64);
const config = {
  mode: "lan", primary: true, siteId, writerEpoch: "2", baselineSha256,
};
const row = {
  site_id: siteId, mode: "lan-primary", epoch: "2",
  baseline_sha256: baselineSha256, role_safe: true, uncovered_tables: 0,
};

test("read-only or cloud deployments never assert LAN writer authority", async () => {
  let called = false;
  const queryable = { query: async () => { called = true; return { rows: [row] }; } };
  assert.equal(await hasVerifiedPhase7WriterAuthority(queryable, { ...config, primary: false }), false);
  assert.equal(await hasVerifiedPhase7WriterAuthority(queryable, { mode: "cloud", primary: true }), false);
  assert.equal(called, false);
});

test("wrong epoch, baseline, site, missing trigger, or privileged app role fail closed", () => {
  assert.equal(isVerifiedPhase7WriterRow(row, config), true);
  for (const modified of [
    { ...row, epoch: 1 }, { ...row, epoch: 3 }, { ...row, mode: "fenced" },
    { ...row, baseline_sha256: "b".repeat(64) },
    { ...row, site_id: "e7a70104-6c73-4ae7-bf1c-44767d59da5c" },
    { ...row, uncovered_tables: 1 }, { ...row, role_safe: false },
    { ...row, role_safe: null },
  ]) assert.equal(isVerifiedPhase7WriterRow(modified, config), false);
  assert.equal(isVerifiedPhase7WriterRow(row, { ...config, writerEpoch: "0" }), false);
  assert.equal(isVerifiedPhase7WriterRow(row, { ...config, baselineSha256: "x" }), false);
});

test("DB error, missing state, duplicates, and role privilege evidence are rejected", async () => {
  assert.equal(await hasVerifiedPhase7WriterAuthority({ query: async () => { throw new Error("DB down"); } }, config), false);
  assert.equal(await hasVerifiedPhase7WriterAuthority({ query: async () => ({ rows: [] }) }, config), false);
  assert.equal(await hasVerifiedPhase7WriterAuthority({ query: async () => ({ rows: [row,row] }) }, config), false);
  assert.equal(await hasVerifiedPhase7WriterAuthority({ query: async () => ({ rows: [row] }) }, config), true);
});

test("manual operator ACK without epoch and digest is refused", () => {
  const env = {
    NODE_ENV: "production", FACTORY_EDGE_MODE: "lan", FACTORY_EDGE_SITE_ID: siteId,
    FACTORY_EDGE_HOSTNAME: "erp.factory.internal", PGHOST: "postgres",
    PGPORT: "5432", PGUSER: "erp_edge", PGPASSWORD: "A".repeat(64),
    PGDATABASE: "erp_edge", PGSSLMODE: "disable",
    SESSION_SECRET: "B".repeat(64), CSRF_ENFORCE: "1",
    ENABLE_SCHEDULERS: "false", RUN_STARTUP_MIGRATIONS: "true",
    FACTORY_EDGE_WRITE_MODE: "lan-primary",
    FACTORY_EDGE_PRIMARY_ACK: "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED",
  };
  assert.throws(() => readFactoryEdgeConfiguration(env), /EDGE_PHASE7_WRITER_EPOCH_REQUIRED/);
  assert.throws(() => readFactoryEdgeConfiguration({
    ...env, FACTORY_EDGE_WRITER_EPOCH: "2"
  }), /EDGE_PHASE7_BASELINE_DIGEST_REQUIRED/);
  assert.equal(readFactoryEdgeConfiguration({
    ...env, FACTORY_EDGE_WRITER_EPOCH: "2",
    FACTORY_EDGE_BASELINE_SHA256: baselineSha256
  }).writerEpoch, "2");
});

test("DBA SQL locks writer-state rows per transaction and fences every current public table", () => {
  const sql = readFileSync(new URL("../deploy/lan/phase7-install-writer-fence.sql", import.meta.url), "utf8");
  assert.match(sql, /FOR SHARE/);
  assert.match(sql, /CREATE TRIGGER phase7_writer_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE/);
  assert.match(sql, /REVOKE ALL ON phase7_writer\.state FROM PUBLIC/);
  assert.match(sql, /'fenced', 'unassigned', 0/);
  assert.match(sql, /n\.nspname = 'public'/);
  assert.doesNotMatch(sql, /CREATE OR REPLACE RULE/);
});
