import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("startup warning repairs", () => {
  it("repairs duplicate exchange-rate rows before creating the unique index", () => {
    const source = read("server/startupWarningRepair.mjs");

    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("to_regclass('public.exchange_rates_company_date_pair_unique')");
    expect(source).toContain("PARTITION BY company_id, effective_date, from_currency, to_currency");
    expect(source).toContain("ORDER BY id DESC");
    expect(source).toContain("duplicate_rank > 1");
    expect(source).toContain("exchange_rates_company_date_pair_unique");
    expect(source).toContain("LOCK TABLE exchange_rates IN SHARE ROW EXCLUSIVE MODE");
  });

  it("runs the repair before the production server entrypoint", () => {
    const runtimeGuard = read("server/runtimeMemoryGuard.mjs");
    expect(runtimeGuard).toContain('import "./startupWarningRepair.mjs"');
  });

  it("self-heals SP supplier-link columns and uses transactional direct SQL", () => {
    const source = read("server/routes/sp/spSupplierVoucherSync.ts");

    for (const required of [
      "information_schema.columns",
      "ALTER TABLE vouchers ADD COLUMN supplier_id INTEGER",
      "ALTER TABLE voucher_entries ADD COLUMN supplier_id INTEGER",
      "ALTER TABLE sp_containers ADD COLUMN supplier_id INTEGER",
      "ALTER TABLE sp_containers ADD COLUMN goods_otw_voucher_id INTEGER",
      "ALTER TABLE ledger_accounts ADD COLUMN sub_type TEXT",
      "sp-supplier-voucher-sync-schema-v1",
      // Wave 16 (A): trigger v2 (no rewrite of posted lines) and the reviewed,
      // company-scoped link repair replace the v1 trigger and global repair.
      "sp-supplier-voucher-sync-trigger-v2",
      "sp-supplier-voucher-link-repair-v2",
      "UPDATE voucher_entries ve",
    ]) {
      expect(source).toContain(required);
    }

    expect(source).not.toContain("WITH candidates AS");
  });

  it("keeps the admin schema diagnostic aligned with SP synchronization", () => {
    const source = read("server/routes/admin/schemaDiagnosticRoutes.ts");

    for (const required of [
      '{ table: "vouchers", column: "supplier_id", ddl: "INTEGER" }',
      '{ table: "voucher_entries", column: "supplier_id",',
      '{ table: "sp_containers", column: "supplier_id",',
      '{ table: "sp_containers", column: "goods_otw_voucher_id",',
      '{ table: "ledger_accounts", column: "sub_type",',
    ]) {
      expect(source).toContain(required);
    }
  });
});
