import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(root, "scripts/verify-authoritative-schema-dump.mjs");
const header = [
  "-- PostgreSQL database dump",
  "-- Dumped from database version 18.1",
  "-- Dumped by pg_dump version 18.1",
  "",
].join("\n");
const footer = "\n-- PostgreSQL database dump complete\n";
const tables = ["companies", "users", "vouchers", "voucher_entries", "stock_items", "locations"]
  .map((name) => "CREATE TABLE public." + name + " (\n    id integer NOT NULL\n);\n")
  .join("\n");
const invoke = (sql) => {
  const dir = mkdtempSync(path.join(tmpdir(), "erp-schema-preflight-"));
  try {
    const filename = path.join(dir, "schema.sql");
    writeFileSync(filename, sql);
    const p = spawnSync(process.execPath, [tool, "--input", filename, "--json"], {
      cwd: root, encoding: "utf8",
    });
    return { status: p.status, result: JSON.parse(p.stdout), stderr: p.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("valid pg_dump-shaped fixture is classified but never certified", () => {
  const out = invoke(header + tables + footer);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.result.checksPassed, true);
  assert.equal(out.result.certification, false);
  assert.equal(out.result.tables, 6);
  assert.equal(out.result.requiredCoreTables.vouchers, true);
  assert.equal(out.result.sourceSha256.length, 64);
});

test("rejects a schema dump missing original core tables", () => {
  const out = invoke(header + "CREATE TABLE public.companies (id integer);\n" + footer);
  assert.equal(out.status, 1);
  assert.ok(out.result.errors.some((value) => value.includes("vouchers")));
});

test("rejects data and sequence state from production", () => {
  const out = invoke(header + tables +
    "COPY public.users (id) FROM stdin;\n1\n\\.\n" +
    "SELECT pg_catalog.setval('public.users_id_seq', 300, true);\n" + footer);
  assert.equal(out.status, 1);
  assert.ok(out.result.errors.some((value) => value.includes("Data-modification")));
  assert.ok(out.result.errors.some((value) => value.includes("Sequence values")));
});

test("rejects database-level provisioning and partial dumps", () => {
  const out = invoke(header + "CREATE DATABASE production;\n" + tables);
  assert.equal(out.status, 1);
  assert.ok(out.result.errors.some((value) => value.includes("database provisioning")));
  assert.ok(out.result.errors.some((value) => value.includes("footer")));
});

test("rejects arbitrary handwritten migration as authoritative baseline", () => {
  const out = invoke(tables);
  assert.equal(out.status, 1);
  assert.ok(out.result.errors.some((value) => value.includes("pg_dump header")));
});
