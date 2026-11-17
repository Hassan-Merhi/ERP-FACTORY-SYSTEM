import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const migrationPath = path.join(
  repoRoot,
  "migrations",
  "archive",
  "legacy",
  "0013_tenant_control_integrity_guards.sql"
);
// Historical (archived) migration and Drizzle journal; the live schema comes from migrations/0001+.
const journalPath = path.join(repoRoot, "migrations", "archive", "legacy", "meta", "_journal.json");
const auditPath = path.join(repoRoot, "scripts", "tenant-control-integrity-audit.mjs");

function withoutSqlComments(value: string): string {
  return value
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("tenant control database guard migration", () => {
  it("is registered as the next versioned migration", () => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    const entry = journal.entries.find(
      (candidate: { tag?: string }) => candidate.tag === "0013_tenant_control_integrity_guards"
    );

    expect(entry).toMatchObject({ idx: 13, version: "7", breakpoints: true });
  });

  it("uses NOT VALID foreign keys and does not mutate historical rows", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const executableSql = withoutSqlComments(migration);

    expect(migration.match(/NOT VALID/g)?.length).toBeGreaterThanOrEqual(8);
    expect(executableSql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\b/im);
    expect(executableSql).not.toMatch(/VALIDATE\s+CONSTRAINT/i);
    expect(executableSql).toContain("enforce_tenant_control_child_company");
    expect(executableSql).toContain("prevent_tenant_control_parent_company_move");
  });

  it("keeps the audit script transactionally read-only", () => {
    const audit = readFileSync(auditPath, "utf8");

    expect(audit).toContain('client.query("BEGIN READ ONLY")');
    expect(audit).toContain('client.query("ROLLBACK")');
    expect(audit).not.toMatch(/client\.query\([^)]*\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/is);
    expect(audit).toContain("TENANT_CONTROL_AUDIT_CHECKS");
  });
});
