import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { columnDefinition, functionDefinition, indexDefinition, triggerDefinition } from "./helpers/schemaManifest";

const read = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("startup warning repairs", () => {
  it("migrations define the exchange-rate pair unique index", () => {
    // The boot-time duplicate cleanup (server/startupWarningRepair.mjs) only
    // existed so it could create this index; the index now comes from migrations.
    expect(indexDefinition("exchange_rates_company_date_pair_unique")).toBe(
      "CREATE UNIQUE INDEX exchange_rates_company_date_pair_unique ON public.exchange_rates USING btree (company_id, effective_date, from_currency, to_currency)"
    );
  });

  it("no longer loads a schema repair before the production server entrypoint", () => {
    const runtimeGuard = read("server/runtimeMemoryGuard.mjs");
    expect(runtimeGuard).not.toContain("startupWarningRepair");
    expect(fs.existsSync(path.resolve(process.cwd(), "server/startupWarningRepair.mjs"))).toBe(false);
  });

  it("migrations define the SP supplier-link columns and trigger; the sync module keeps the reviewed repair", () => {
    // The supplier-link columns, trigger function and trigger are now created by
    // migrations only (no runtime self-heal); assert they are in the manifest.
    for (const [table, column, type] of [
      ["vouchers", "supplier_id", "integer"],
      ["voucher_entries", "supplier_id", "integer"],
      ["sp_containers", "supplier_id", "integer"],
      ["sp_containers", "goods_otw_voucher_id", "integer"],
      ["ledger_accounts", "sub_type", "text"],
    ] as const) {
      expect(columnDefinition(table, column)?.type).toBe(type);
    }
    // Wave 16 (A): trigger v2 does not rewrite posted lines: a supplier change
    // only follows a voucher that is not posted (optional = true).
    const fn = functionDefinition("sync_sp_container_supplier_to_voucher") ?? "";
    expect(fn).toContain("UPDATE voucher_entries ve");
    expect(fn).toContain("AND optional = true");
    expect(fn).toContain("AND v.optional = true");
    expect(fn).toContain("AND supplier_id IS NULL");
    expect(triggerDefinition("sp_containers", "trg_sp_container_supplier_voucher_sync")).toContain(
      "AFTER INSERT OR UPDATE OF supplier_id, goods_otw_voucher_id ON public.sp_containers FOR EACH ROW EXECUTE FUNCTION sync_sp_container_supplier_to_voucher()"
    );

    const source = read("server/routes/sp/spSupplierVoucherSync.ts");
    // The reviewed, company-scoped link repair replaces the v1 global repair.
    expect(source).toContain("sp-supplier-voucher-link-repair-v2");
    expect(source).not.toContain("WITH candidates AS");
    expect(source).not.toMatch(/ALTER TABLE|CREATE (OR REPLACE )?(FUNCTION|TRIGGER)|DROP TRIGGER/);
  });

  it("keeps the admin schema diagnostic aligned with SP synchronization", () => {
    const source = read("server/routes/admin/schemaDiagnosticRoutes.ts");

    for (const [table, column] of [
      ["vouchers", "supplier_id"],
      ["voucher_entries", "supplier_id"],
      ["sp_containers", "supplier_id"],
      ["sp_containers", "goods_otw_voucher_id"],
      ["ledger_accounts", "sub_type"],
    ]) {
      const required = `{ table: "${table}", column: "${column}" }`;
      expect(columnDefinition(table, column), `${table}.${column}`).toBeDefined();
      expect(source).toContain(required);
    }
  });
});
