import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Historical data repair (archived; already applied in production, not replayed).
const migration = readFileSync("migrations/archive/legacy/20260728_001_supplier_company_scope.sql", "utf8");

describe("supplier company-scope migration repair", () => {
  it("repairs historical CREATE-audit ownership before the legacy parent fallback", () => {
    const repairIndex = migration.indexOf("WITH unique_create_owner AS");
    const fallbackIndex = migration.indexOf("UPDATE suppliers\n       SET company_id = configured_parent_id");

    expect(repairIndex).toBeGreaterThan(-1);
    expect(fallbackIndex).toBeGreaterThan(repairIndex);
    expect(migration).toContain("HAVING COUNT(DISTINCT company_id) = 1");
    expect(migration).toContain("s.company_id IS DISTINCT FROM owner.company_id");
  });

  it("keeps the parent fallback limited to suppliers that are still unowned", () => {
    expect(migration).toContain("SET company_id = configured_parent_id\n     WHERE company_id IS NULL");
  });

  it("contains the confirmed production repair for HMD BEIRUT", () => {
    expect(migration).toContain("id = 28");
    expect(migration).toContain("UPPER(TRIM(legal_name)) = 'HMD BEIRUT'");
    expect(migration).toContain("SET company_id = 17");
    expect(migration).toContain("company_id IS DISTINCT FROM 17");
  });
});
