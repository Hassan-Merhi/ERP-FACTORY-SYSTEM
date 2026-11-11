import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../scripts/audit-erp-operations-phase2.ts", import.meta.url), "utf8");

describe("ERP Phase 2 operational audit safety contract", () => {
  it("explicitly prevents apply and repair modes", () => {
    expect(source).toContain('process.argv.includes("--apply")');
    expect(source).toContain('process.argv.includes("--repair")');
    expect(source).toContain("Read-only operational audit: apply/repair is forbidden");
  });

  it("limits every audit to a selected company and uses a read-only transaction", () => {
    expect(source).toContain("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(source).toContain("SELECT set_config('app.current_company_id', $1, true)");
    expect(source).toContain("WHERE id=$1");
    expect(source).toContain('await client.query("ROLLBACK")');
    expect(source).toContain('client.release()');
  });

  it("does not silently interpret a false transfer flag as missing stock", () => {
    expect(source).toContain("stock-transfer-import-multi-source");
    expect(source).toContain("canonical_rows");
    expect(source).toContain("not permission to replay stock");
  });

  it("does not insert, update or delete source financial or inventory records", () => {
    expect(source).not.toMatch(/client\.query\(\s*["'`]\s*(?:INSERT|UPDATE|DELETE|ALTER|TRUNCATE|DROP)\b/i);
  });
});
