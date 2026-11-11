import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Factory Phase 2 reviewed company-scope audit exceptions", () => {
  it("keeps the exceptional global container-number guard tied to a globally unique column", () => {
    const schema = source("shared/schema/containers.ts");
    const receipt = source("server/routes/import/factoryDispatchPoImportReceipt.ts");
    expect(schema).toContain('containerNumber: varchar("container_number", { length: 100 }).notNull().unique()');
    expect(receipt).toContain(
      "SELECT id,status FROM containers WHERE container_number=${scope.identity.containerNumber} LIMIT 1"
    );
    expect(receipt).toContain("FD_PO_CONTAINER_ALREADY_EXISTS");
    expect(receipt).toContain("WHERE erp_company_id=${companyId}");
    expect(receipt).toContain("WHERE id=${receiptId} AND erp_company_id=${companyId}");
  });

  it("limits the reviewed vouchers mention to a catalog trigger probe", () => {
    const posting = source("server/services/factory/dispatchTripFinancialPosting.ts");
    expect(posting).toContain("async function assertHardenedFinancialSchemaTx");
    expect(posting).toContain("FROM pg_trigger");
    expect(posting).toContain("tgrelid=to_regclass('public.vouchers')");
    expect(posting).toContain("WHERE o.company_id = ${scope.companyId} AND o.id = ${scope.orderId}");
    expect(posting).toContain("WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}");
  });

  it("documents both exceptions without dropping the fail-on-findings gate", () => {
    const registry = JSON.parse(source("config/company-scope-review.json")) as {
      reviews: Array<{ path: string; reason: string }>;
    };
    for (const path of [
      "server/routes/import/factoryDispatchPoImportReceipt.ts",
      "server/services/factory/dispatchTripFinancialPosting.ts",
    ]) {
      const review = registry.reviews.find((row) => row.path === path);
      expect(review?.reason).toMatch(/Reviewed 2026-11-10/);
      expect(review?.reason.length).toBeGreaterThan(100);
    }
    const audit = source("scripts/audit-company-scope.mjs");
    expect(audit).toContain('const failOnFindings = process.argv.includes("--fail-on-findings")');
    expect(audit).toContain("unreviewedFindings");
    expect(audit).toContain("process.exit(1)");
  });
});
