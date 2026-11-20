/**
 * Supplier Payable Excel import validation
 * (server/routes/sp/spContainerRoutesValidateSpExcelImport.ts): header
 * fields, supplier checks (missing, another company's, renamed), charges,
 * line validation, stock item links from another company, Golden Coast
 * Fresh Start rules, total reconciliation and duplicate containers. Runs on
 * one rolled-back transaction per case.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import {
  isFreshStartOtwCompany,
  validateSpExcelImport,
} from "../server/routes/sp/spContainerRoutesValidateSpExcelImport";
import { withRolledBackPool } from "./helpers/routedPoolClient";

let seq = 0;

interface World {
  client: PoolClient;
  companyId: number;
  otherCompanyId: number;
  supplierId: number;
  foreignSupplierId: number;
  itemA: number;
  itemB: number;
  foreignItem: number;
}

async function withWorld(work: (w: World) => Promise<void>) {
  await withRolledBackPool(async (client) => {
    const tag = `SPX${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase();
    const one = async (text: string, params: unknown[]) => Number((await client.query(text, params)).rows[0].id);
    const company = (suffix: string) =>
      one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [`${tag}${suffix}`]);
    const companyId = await company("A");
    const otherCompanyId = await company("B");
    const supplier = (cid: number, code: string) =>
      one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Real Supplier', 's@x.test') RETURNING id`,
        [cid, `${tag}${code}`]
      );
    const item = (cid: number, code: string) =>
      one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2::varchar, $2::text, 'kg') RETURNING id`,
        [cid, `${tag}${code}`]
      );
    await work({
      client,
      companyId,
      otherCompanyId,
      supplierId: await supplier(companyId, "S"),
      foreignSupplierId: await supplier(otherCompanyId, "FS"),
      itemA: await item(companyId, "IA"),
      itemB: await item(companyId, "IB"),
      foreignItem: await item(otherCompanyId, "FI"),
    });
  });
}

const valid = (w: World, over: Record<string, unknown> = {}) => ({
  supplierId: w.supplierId,
  supplierName: "Real Supplier",
  containerNumber: " MSCU1234567 ",
  invoiceNumber: "INV-1",
  invoiceDate: "2026-04-01",
  // (10 x 10 + 5 x 16) less 10%, plus 10 freight
  invoiceTotalUsd: 172,
  discountPct: 10,
  freightEstimateUsd: 10,
  lines: [
    { articleCode: "A", qty: 10, unitRateUsd: 10, stockItemId: w.itemA },
    { articleCode: "B", qty: 5, unitRateUsd: 16, stockItemId: w.itemB },
  ],
  ...over,
});

describe("validateSpExcelImport", () => {
  it("accepts a reconciled import with no warnings", async () => {
    await withWorld(async (w) => {
      expect(await validateSpExcelImport(w.companyId, valid(w))).toEqual({ errors: [], warnings: [] });
    });
  });

  it("reports every invalid header field and charge", async () => {
    await withWorld(async (w) => {
      const result = await validateSpExcelImport(w.companyId, {
        supplierId: "x",
        containerNumber: " ",
        invoiceNumber: "",
        invoiceDate: "2026-13-45",
        invoiceTotalUsd: -1,
        discountPct: 101,
        surchargeUsd: -5,
        fumigationUsd: "abc",
        lines: "not-an-array",
      });
      expect(result.errors).toEqual([
        "Select a valid supplier.",
        "Container number is required.",
        "Invoice / PO number is required.",
        "A valid invoice date is required.",
        "Invoice total must be positive.",
        "Discount must be between 0 and 100%.",
        "Excel must contain 1 to 10,000 valid item lines.",
        "surchargeUsd must be a non-negative amount.",
        "fumigationUsd must be a non-negative amount.",
      ]);
    });
  });

  it("refuses another company's supplier, a renamed supplier, and skips the check when asked", async () => {
    await withWorld(async (w) => {
      const foreign = await validateSpExcelImport(w.companyId, valid(w, { supplierId: w.foreignSupplierId }));
      expect(foreign.errors).toEqual(["Supplier is not available in the selected Supplier Payable company."]);
      const renamed = await validateSpExcelImport(w.companyId, valid(w, { supplierName: "Old Name" }));
      expect(renamed.errors).toEqual(["Supplier details changed. Select the supplier again."]);
      const unchecked = await validateSpExcelImport(
        w.companyId,
        valid(w, { supplierName: "Old Name" }),
        undefined,
        false
      );
      expect(unchecked.errors).toEqual([]);
    });
  });

  it("flags bad lines, unmatched lines, foreign or invalid stock links and an unreconciled total", async () => {
    await withWorld(async (w) => {
      const badLines = await validateSpExcelImport(
        w.companyId,
        valid(w, {
          lines: [
            { articleCode: "", qty: 1, unitRateUsd: 1 },
            { articleCode: "X", qty: 0, unitRateUsd: 1 },
            { articleCode: "Y", qty: 1, unitRateUsd: -1 },
          ],
        })
      );
      expect(badLines.errors).toEqual([
        "Invalid code, quantity or rate on line 1.",
        "Invalid code, quantity or rate on line 2.",
        "Invalid code, quantity or rate on line 3.",
      ]);
      expect(badLines.warnings).toEqual([
        "3 item line(s) have no matching stock item/alias; map them before offloading.",
      ]);

      const foreignItem = await validateSpExcelImport(
        w.companyId,
        valid(w, {
          invoiceTotalUsd: 100,
          discountPct: 0,
          freightEstimateUsd: 0,
          lines: [{ articleCode: "F", qty: 1, unitRateUsd: 100, stockItemId: w.foreignItem }],
        })
      );
      expect(foreignItem.errors).toEqual(["An imported stock item belongs to another company or no longer exists."]);

      const invalidLink = await validateSpExcelImport(
        w.companyId,
        valid(w, {
          lines: [{ articleCode: "F", qty: 1, unitRateUsd: 1, stockItemId: -3 }],
        })
      );
      expect(invalidLink.errors).toEqual(["Invalid stock item link in the imported Excel lines."]);

      const unreconciled = await validateSpExcelImport(w.companyId, valid(w, { invoiceTotalUsd: 500 }));
      expect(unreconciled.errors).toEqual(["Invoice total does not reconcile with item lines, discount and charges."]);
    });
  });

  it("stops listing line errors after twenty", async () => {
    await withWorld(async (w) => {
      const lines = Array.from({ length: 40 }, () => ({ articleCode: "", qty: 1, unitRateUsd: 1 }));
      const result = await validateSpExcelImport(w.companyId, valid(w, { lines }));
      expect(result.errors.filter((e) => e.startsWith("Invalid code")).length).toBe(21);
    });
  });

  it("applies the Fresh Start rules: no supplier, the fixed source name, mapped unique items, at most 100 lines", async () => {
    await withWorld(async (w) => {
      const refused = await validateSpExcelImport(
        w.companyId,
        valid(w, {
          supplierName: "Someone",
          lines: [
            { articleCode: "A", qty: 1, unitRateUsd: 1, stockItemId: w.itemA },
            { articleCode: "A2", qty: 1, unitRateUsd: 1, stockItemId: w.itemA },
            { articleCode: "U", qty: 1, unitRateUsd: 1 },
          ],
        }),
        undefined,
        true,
        true
      );
      expect(refused.errors).toEqual([
        "Fresh Start FZE imports cannot be linked to a supplier account.",
        "Fresh Start FZE is the required internal container source.",
        "1 Excel item line(s) have no matching GC-LSHI stock item. Add or map stock items before importing into Golden Coast Phase 8.",
        "Golden Coast Phase 8 requires each stock item only once in a container. Consolidate duplicate item rows.",
      ]);

      const many = Array.from({ length: 101 }, () => ({
        articleCode: "A",
        qty: 1,
        unitRateUsd: 1,
        stockItemId: w.itemA,
      }));
      const tooMany = await validateSpExcelImport(
        w.companyId,
        valid(w, { supplierId: null, supplierName: "Fresh Start FZE", lines: many }),
        undefined,
        true,
        true
      );
      expect(tooMany.errors).toContain("Golden Coast Phase 8 supports up to 100 item lines in one container.");

      const ok = await validateSpExcelImport(
        w.companyId,
        valid(w, { supplierId: "", supplierName: "Fresh Start FZE" }),
        undefined,
        true,
        true
      );
      expect(ok.errors).toEqual([]);
    });
  });

  it("refuses a container already imported for the company, ignoring cancelled ones", async () => {
    await withWorld(async (w) => {
      const insert = (status: string) =>
        w.client.query(
          `INSERT INTO sp_containers (company_id, container_number, invoice_number, invoice_date, supplier_name, status)
           VALUES ($1, 'mscu1234567', 'X', '2026-01-01', 'S', $2)`,
          [w.companyId, status]
        );
      await insert("cancelled");
      expect((await validateSpExcelImport(w.companyId, valid(w))).errors).toEqual([]);
      await insert("open");
      expect((await validateSpExcelImport(w.companyId, valid(w))).errors).toEqual([
        "This container is already imported for this company.",
      ]);
      expect((await validateSpExcelImport(w.otherCompanyId, valid(w), undefined, false)).errors).toEqual([
        "An imported stock item belongs to another company or no longer exists.",
      ]);
    });
  });
});

describe("isFreshStartOtwCompany", () => {
  it("needs both active Golden Coast capital roles", async () => {
    await withWorld(async (w) => {
      const account = (code: string, subType: string) =>
        w.client.query(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type) VALUES ($1, $2::varchar, $2::text, 'Equity', $3)`,
          [w.companyId, `${code}${w.companyId}`, subType]
        );
      expect(await isFreshStartOtwCompany(w.companyId)).toBe(false);
      await account("PC", "gc_partner_capital");
      expect(await isFreshStartOtwCompany(w.companyId)).toBe(false);
      await account("OC", "gc_owner_capital");
      expect(await isFreshStartOtwCompany(w.companyId)).toBe(true);
    });
  });
});
