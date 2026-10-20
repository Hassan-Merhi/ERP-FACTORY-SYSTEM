import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("voucher account-group exclusions", () => {
  it("filters both explicitly tagged groups and old ledger parent headers from voucher options", () => {
    const reads = source("server/routes/ledger/reads.ts");
    expect(reads).toContain('req.query.profile === "voucher-picker"');
    expect(reads).toContain("IS DISTINCT FROM 'Group'");
    expect(reads).toContain("NOT EXISTS (");
    expect(reads).toContain("voucher_group_child.parent_id");
    expect(reads).toContain("voucher_group_child.deleted_at IS NULL");

    const sidebar = source("server/routes/accounts/voucher-sidebar.ts");
    expect(sidebar).toContain('["sp_stock", "sp_opnbal", "Group"]');
    expect(sidebar).toContain("!groupParentIds.has(a.id)");
  });

  it("uses voucher-specific filtered options in all payment and journal account selectors", () => {
    for (const file of [
      "client/src/pages/vouchers/useVoucherQueries.ts",
      "client/src/pages/vouchers/journalform/useJournalFormModel.tsx",
      "client/src/pages/voucher-edit/useVoucherEditQueries.ts",
      "client/src/components/VoucherEditDialog.tsx",
    ]) {
      expect(source(file), file).toContain("profile=voucher-picker");
    }
  });
});
