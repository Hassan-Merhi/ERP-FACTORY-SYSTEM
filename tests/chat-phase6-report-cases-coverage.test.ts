/**
 * Chat report phase 6 cases (supplier / customer proformas, mix batches,
 * supplier and customer lists) run against PostgreSQL in one rolled-back
 * transaction per test. The phase 6 stock item detail handler is not
 * exercised: the report registry routes "stock_item_detail" to the
 * schema-compatibility shard, so it is never called in production.
 *
 * Pinned: company scoping, name / status / date filters, totals and labels.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import {
  runPhase6CustomerList,
  runPhase6CustomerProformas,
  runPhase6FactoryMixBatches,
  runPhase6SupplierList,
  runPhase6SupplierProformas,
} from "../server/chat/reports/implementations/phase6ReportCases";

const fmt = (n: number) => n.toFixed(2);
const fmtDec = (n: number) => n.toFixed(3);
let seq = 0;

const otherCompany = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`, [
    `${w.tag}O${++seq}`,
  ]);
const supplier = (w: FactoryWorld, name: string, companyId = w.companyId, extra: string | null = null) =>
  w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email, phone, payment_terms)
     VALUES ($1, $2, $3, COALESCE($4, ''), $4, $4) RETURNING id`,
    [companyId, `${w.tag}S${++seq}`, name, extra]
  );
const customer = (w: FactoryWorld, name: string, companyId = w.companyId) =>
  w.one(`INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`, [
    companyId,
    `${w.tag}C${++seq}`,
    name,
  ]);

describe("phase 6 proforma reports", () => {
  it("lists supplier proformas with totals and filters by supplier name", () =>
    withFactoryWorld(async (w) => {
      const base = { companyId: w.companyId, rowLimit: 50, fmt };
      expect(await runPhase6SupplierProformas({ ...base, params: { queryType: "supplier_proformas" } })).toMatchObject({
        noData: true,
        title: "Supplier Proformas",
      });
      const acme = await supplier(w, "Acme Mills");
      const zen = await supplier(w, "Zen Rags");
      const pf = await w.one(
        `INSERT INTO supplier_proformas (company_id, supplier_id, reference, notes) VALUES ($1, $2, 'PF-ACME', 'first') RETURNING id`,
        [w.companyId, acme]
      );
      await w.q(
        `INSERT INTO supplier_proforma_lines (proforma_id, barcode, item_name, qty, price_per_bale)
         VALUES ($1, 'B1', 'Cream', 2, 10), ($1, 'B2', 'Mixed', 3, 5)`,
        [pf]
      );
      await w.q(`INSERT INTO supplier_proformas (company_id, supplier_id, reference) VALUES ($1, $2, 'PF-ZEN')`, [
        w.companyId,
        zen,
      ]);
      const all = await runPhase6SupplierProformas({ ...base, params: { queryType: "supplier_proformas" } });
      expect(all.table.rows).toHaveLength(2);
      const acmeOnly = await runPhase6SupplierProformas({ ...base, params: { queryType: "x", entityName: "acme" } });
      expect(acmeOnly.title).toBe("Supplier Proformas: acme");
      expect(acmeOnly.table.rows).toEqual([
        ["PF-ACME", "Acme Mills", "2", "5.000", "35.00", expect.any(String), "first"],
      ]);
    }));

  it("lists active customer proformas first, skips deleted ones and other companies", () =>
    withFactoryWorld(async (w) => {
      const base = { companyId: w.companyId, rowLimit: 50, fmt };
      const amina = await customer(w, "Amina Traders");
      const bilal = await customer(w, "Bilal Imports");
      const proforma = (customerId: number, name: string, active: boolean, companyId = w.companyId) =>
        w.one(
          `INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1, $2, $3, $4) RETURNING id`,
          [companyId, customerId, name, active]
        );
      const live = await proforma(amina, "Amina PF", true);
      await w.q(
        `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
         VALUES ($1, 'ART-A', 'A', 4, 12.5)`,
        [live]
      );
      await proforma(bilal, "Bilal PF", false);
      const gone = await proforma(bilal, "Gone PF", true);
      await w.q(`UPDATE customer_proformas SET deleted_at = now() WHERE id = $1`, [gone]);
      const other = await otherCompany(w);
      await proforma(await customer(w, "Foreign", other), "Foreign PF", true, other);

      const all = await runPhase6CustomerProformas({ ...base, params: { queryType: "customer_proformas" } });
      expect(all.table.rows.map((r) => [r[0], r[4], r[5]])).toEqual([
        ["Amina PF", "50.00", "Active"],
        ["Bilal PF", "0.00", "Inactive"],
      ]);
      const filtered = await runPhase6CustomerProformas({ ...base, params: { queryType: "x", entityName: "bilal" } });
      expect([filtered.title, filtered.table.rows.length]).toEqual(["Customer Proformas: bilal", 1]);
      const none = await runPhase6CustomerProformas({ ...base, params: { queryType: "x", entityName: "nobody" } });
      expect(none.noData).toBe(true);
    }));
});

describe("phase 6 mix batches", () => {
  it("summarises live batches with usage and filters by status and date", () =>
    withFactoryWorld(async (w) => {
      const base = { companyId: w.companyId, rowLimit: 50, fmt, fmtDec };
      const batch = (code: string, status: string, date: string | null, total: string, used: string, deleted = false) =>
        w.q(
          `INSERT INTO factory_mix_batches (company_id, batch_code, batch_number, name, batch_date, status, total_weight_kg,
             used_kg, cost_per_kg, total_cost, operator_user, deleted_at)
           VALUES ($1, $2::varchar, $2::text, $3, $4, $5, $6, $7, 0.5, $6::numeric * 0.5, $8, $9)`,
          [
            w.companyId,
            `${w.tag}${code}`,
            code === "A" ? "Alpha" : null,
            date,
            status,
            total,
            used,
            code === "A" ? "op" : null,
            deleted ? new Date() : null,
          ]
        );
      await batch("A", "OPEN", "2026-06-10", "100", "25");
      await batch("B", "CLOSED", null, "0", "0");
      await batch("C", "OPEN", "2026-05-01", "40", "40", true);
      const all = await runPhase6FactoryMixBatches({ ...base, params: { queryType: "factory_mix_batches" } });
      expect(all.title).toBe("Factory Mix Batches");
      const byCode = Object.fromEntries(all.table.rows.map((r) => [r[0], r]));
      expect(byCode[`${w.tag}A`]).toEqual([
        `${w.tag}A`,
        "Alpha",
        "2026-06-10",
        "OPEN",
        "100.000",
        "25.000",
        "75.000",
        "25.0%",
        "0.500",
        "op",
      ]);
      expect(byCode[`${w.tag}B`]).toEqual([
        `${w.tag}B`,
        "—",
        "—",
        "CLOSED",
        "0.000",
        "0.000",
        "0.000",
        "—",
        "0.500",
        "—",
      ]);
      expect(all.stats.find((s) => s.label === "Total Cost")?.value).toBe("50.00");
      const open = await runPhase6FactoryMixBatches({
        ...base,
        params: { queryType: "x", entityName: "open", dateFrom: "2026-06-01" },
      });
      expect([open.title, open.table.rows.length]).toEqual(["Mix Batches — OPEN", 1]);
    }));
});

describe("phase 6 supplier and customer lists", () => {
  it("ranks suppliers with this company's purchase orders by total ordered", () =>
    withFactoryWorld(async (w) => {
      const base = { companyId: w.companyId, rowLimit: 50, fmt };
      const big = await supplier(w, "Big Supply", w.companyId, "x@y");
      const small = await supplier(w, "Small Supply");
      await supplier(w, "Idle Supply");
      await w.q(`UPDATE suppliers SET active = FALSE WHERE id = $1`, [small]);
      const po = async (supplierId: number, total: string) => {
        const containerId = await w.one(
          `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status, items_total,
             charges_total, grand_total)
           VALUES ($1, $2, '2026-06-01', $3, 'OTW', $4, 0, $4) RETURNING id`,
          [w.companyId, `${w.tag}K${++seq}`, supplierId, total]
        );
        await w.q(
          `INSERT INTO purchase_orders (company_id, container_id, supplier_id, po_number, items_total, currency, status)
           VALUES ($1, $2, $3, $4, $5, 'USD', 'Open')`,
          [w.companyId, containerId, supplierId, `${w.tag}PO${++seq}`, total]
        );
      };
      await po(big, "300");
      await po(big, "200");
      await po(small, "50");
      const list = await runPhase6SupplierList({ ...base, params: { queryType: "supplier_list" } });
      expect(list.table.rows).toEqual([
        [expect.any(String), "Big Supply", "x@y", "x@y", "x@y", "2", "500.00", "Active"],
        [expect.any(String), "Small Supply", "—", "—", "—", "1", "50.00", "Inactive"],
      ]);
      expect(list.stats[1]).toEqual({ label: "Total POs", value: "3" });
      const filtered = await runPhase6SupplierList({ ...base, params: { queryType: "x", entityName: "small" } });
      expect([filtered.title, filtered.table.rows.length]).toEqual(["Suppliers: small", 1]);
    }));

  it("reports customer balances from opening balance and ledger entries", () =>
    withFactoryWorld(async (w) => {
      const base = { companyId: w.companyId, rowLimit: 50, fmt };
      const ledger = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'AR Amina', 'Asset') RETURNING id`,
        [w.companyId, `${w.tag}AR`]
      );
      const amina = await customer(w, "Amina");
      await w.q(
        `UPDATE customers SET ledger_account_id = $2, opening_balance = 100, opening_balance_side = 'Dr',
           payment_terms_days = 30, phone = '555' WHERE id = $1`,
        [amina, ledger]
      );
      const zara = await customer(w, "Zara");
      await w.q(
        `UPDATE customers SET opening_balance = 40, opening_balance_side = 'Cr', active = FALSE WHERE id = $1`,
        [zara]
      );
      const v = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-06-01', 25) RETURNING id`,
        [w.companyId, `${w.tag}V1`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 25, 0)`,
        [v, ledger]
      );
      const list = await runPhase6CustomerList({ ...base, params: { queryType: "customer_list" } });
      expect(list.table.rows.map((r) => r.slice(1))).toEqual([
        ["Amina", "555", "30d", "125.00 Dr", "Active"],
        ["Zara", "—", "—", "40.00 Cr", "Inactive"],
      ]);
      expect(list.stats[1]).toMatchObject({ value: "125.00" });
      const filtered = await runPhase6CustomerList({ ...base, params: { queryType: "x", entityName: "zara" } });
      expect([filtered.title, filtered.table.rows.length]).toEqual(["Customers: zara", 1]);

      // Entries of a deleted or an optional voucher do not count toward the balance.
      const removed = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-06-02', 1000) RETURNING id`,
        [w.companyId, `${w.tag}V2`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 1000, 0)`,
        [removed, ledger]
      );
      await w.q(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [removed]);
      const optional = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
         VALUES ($1, $2, 'Journal', '2026-06-03', 500, TRUE) RETURNING id`,
        [w.companyId, `${w.tag}V3`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, 500)`,
        [optional, ledger]
      );
      const after = await runPhase6CustomerList({ ...base, params: { queryType: "x", entityName: "amina" } });
      expect(after.table.rows[0][4]).toBe("125.00 Dr");
      expect(after.stats[1]).toMatchObject({ value: "125.00" });

      // A customer whose ledger holds only such entries keeps its opening balance.
      const zaraLedger = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'AR Zara', 'Asset') RETURNING id`,
        [w.companyId, `${w.tag}AZ`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 500, 0)`,
        [optional, zaraLedger]
      );
      await w.q(`UPDATE customers SET ledger_account_id = $2 WHERE id = $1`, [zara, zaraLedger]);
      const onlyExcluded = await runPhase6CustomerList({ ...base, params: { queryType: "x", entityName: "zara" } });
      expect(onlyExcluded.table.rows[0][4]).toBe("40.00 Cr");
    }));
});
