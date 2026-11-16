import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startupMigrations } from "../server/startup-schema";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/extract-startup-schema-migrations.ts");

describe("Phase 3 startup-schema SQL extraction", () => {
  it("converts exactly 43 source modules in the original order, with no DB connection", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "erp-startup-sql-"));
    try {
      const child = spawnSync(process.execPath,
        ["--import", "tsx", script, "--out", dir],
        { cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: "" }, maxBuffer: 1024 * 1024 });
      expect(child.status, child.stderr).toBe(0);
      const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
      expect(manifest.status).toBe("REVIEW_ONLY_NOT_REGISTERED");
      expect(manifest.databaseAccess).toBe(false);
      expect(manifest.modules).toHaveLength(43);
      expect(manifest.totalStatements).toBe(startupMigrations.length);
      expect(manifest.modules.map((m: any) => m.ordinal)).toEqual(
        Array.from({ length: 43 }, (_, i) => i + 1)
      );
      expect(manifest.modules[5].module).toContain("005-orphan-fk-repairs");
      expect(manifest.modules[4].module).toContain("005-tenant-and-performance-indexes");
      expect(manifest.requiresManualDmlReview).toContain(manifest.modules[5].fileName);
      const files = readdirSync(dir).filter((file) => file.endsWith(".sql"));
      expect(files).toHaveLength(43);
      for (const entry of manifest.modules) {
        const sql = readFileSync(path.join(dir, entry.fileName), "utf8");
        expect(sql).toContain("REVIEW ONLY");
        expect(sql).toContain("Original execution position");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses direct output into the executable controlled migration folder", () => {
    const child = spawnSync(process.execPath,
      ["--import", "tsx", script, "--out", path.join(root, "migrations/controlled")],
      { cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toMatch(/Refusing to write directly/);
  });
});
