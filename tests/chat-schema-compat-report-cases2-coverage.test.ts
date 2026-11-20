/**
 * Chat schema-compatibility report cases (supplier container history, stock
 * item detail, container cost breakdown) driven directly against PostgreSQL
 * in one rolled-back transaction per test. Pins the name prompts, not-found
 * replies, currency fallback, blank-field dashes and every optional cost line.
 */
import { describe, expect, it } from "vitest";

import { withReportWorld, type ReportWorld } from "./helpers/reportCaseWorld";
import {
  runSchemaCompatibilityContainerCostBreakdown,
  runSchemaCompatibilityStockItemDetail,
  runSchemaCompatibilitySupplierContainerHistory,
} from "../server/chat/reports/implementations/schemaCompatibilityReportCases2";

const fmt = (n: number) => n.toFixed(2);
const fmtDec = (n: number) => n.toFixed(3);

const supplier = (w: ReportWorld, name: string, companyId = w.companyId) =>
  w.one(`INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, $3, '') RETURNING id`, [
    companyId,
    `${w.tag}S${name.length}${companyId}`,
    name,
  ]);

const container = (
  w: ReportWorld,
  supplierId: number,
  suffix: string,
  extra: {
    status?: string;
    importDate?: string;
    eta?: string | null;
    grand?: number;
    kg?: number | null;
    item?: string | null;
    transport?: number | null;
    duty?: number | null;
    transporter?: string | null;
    agent?: string | null;
    companyId?: number;
  } = {}
) =>
  w.one(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status, eta, grand_total, total_kg,
       rate_per_kg, item_name, items_total, charges_total, transport_fee, duty_fee, transporter, agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1.25, $9, 80, 20, $10, $11, $12, $13) RETURNING id`,
    [
      extra.companyId ?? w.companyId,
      `${w.tag}${suffix}`,
      extra.importDate ?? "2026-04-01",
      supplierId,
      extra.status ?? "OTW",
      extra.eta ?? null,
      extra.grand ?? 100,
      extra.kg ?? null,
      extra.item ?? null,
      extra.transport ?? null,
      extra.duty ?? null,
      extra.transporter ?? null,
      extra.agent ?? null,
    ]
  );

describe("supplier container history", () => {
  it("asks for a supplier and reports no containers for an unknown one", () =>
    withReportWorld(async (w) => {
      const base = { companyId: w.companyId, rowLimit: 10, fmt, fmtDec };
      expect(
        await runSchemaCompatibilitySupplierContainerHistory({ ...base, params: { queryType: "x" } })
      ).toMatchObject({ summary: "Please specify a supplier name." });
      const r = await runSchemaCompatibilitySupplierContainerHistory({
        ...base,
        params: { queryType: "x", entityName: "ghost" },
      });
      expect(r).toMatchObject({ title: "Supplier Containers: ghost", noData: true });
      expect(r.stats?.at(-1)).toEqual({ label: "Status Mix", value: "—" });
    }));

  it("lists containers with status mix, currency fallback and dashes", () =>
    withReportWorld(async (w) => {
      const acme = await supplier(w, "Acme Mills");
      const first = await container(w, acme, "C1", {
        status: "Arrived",
        eta: "2026-03-20",
        kg: 1000,
        item: "Cream",
        importDate: "2026-04-02",
      });
      await w.q(
        `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, currency) VALUES ($1, $2, $3, $4, 'EUR')`,
        [w.companyId, first, `${w.tag}PO`, acme]
      );
      await container(w, acme, "C2", { importDate: "2026-04-01" });
      await container(w, acme, "C3", { importDate: "2026-03-01" });
      const other = await w.otherCompany();
      await container(w, await supplier(w, "Acme Mills", other), "X1", { companyId: other });
      const r = await runSchemaCompatibilitySupplierContainerHistory({
        companyId: w.companyId,
        rowLimit: 10,
        fmt,
        fmtDec,
        params: { queryType: "x", entityName: "acme" },
      });
      expect(r.title).toBe("Supplier Containers: Acme Mills");
      expect(r.table?.rows).toEqual([
        [`${w.tag}C1`, "Arrived", "2026-04-02", "2026-03-20", "1000.000", "100.00", "EUR", "Cream"],
        [`${w.tag}C2`, "OTW", "2026-04-01", "—", "0.000", "100.00", "USD", "—"],
        [`${w.tag}C3`, "OTW", "2026-03-01", "—", "0.000", "100.00", "USD", "—"],
      ]);
      expect(r.stats?.map((s) => s.value)).toEqual(["3", "1000.000", "300.00", "Arrived: 1 · OTW: 2"]);
    }));
});

describe("stock item detail", () => {
  it("asks for an item and reports an unknown item", () =>
    withReportWorld(async (w) => {
      const base = { companyId: w.companyId, fmt, fmtDec };
      expect(await runSchemaCompatibilityStockItemDetail({ ...base, params: { queryType: "x" } })).toEqual({
        queryType: "stock_item_detail",
        title: "Stock Item Detail",
        summary: "Please specify an item name.",
      });
      expect(
        await runSchemaCompatibilityStockItemDetail({ ...base, params: { queryType: "x", entityName: "ghost" } })
      ).toMatchObject({ summary: 'No item found matching "ghost".' });
    }));

  it("shows an ungrouped item without stock as negative", () =>
    withReportWorld(async (w) => {
      await w.q(`INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Lonely Rag', 'KG')`, [
        w.companyId,
        `${w.tag}I`,
      ]);
      const r = await runSchemaCompatibilityStockItemDetail({
        companyId: w.companyId,
        fmt,
        fmtDec,
        params: { queryType: "x", entityName: "lonely" },
      });
      expect(r.noData).toBe(true);
      expect(r.stats?.find((s) => s.label === "Group")?.value).toBe("—");
      expect(r.stats?.find((s) => s.label === "Total Stock")).toMatchObject({
        value: "0.000 KG",
        highlight: "negative",
      });
    }));

  it("totals positive stock across locations for a grouped item", () =>
    withReportWorld(async (w) => {
      const group = await w.one(
        `INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2, 'Rags') RETURNING id`,
        [w.companyId, `${w.tag}G`]
      );
      const item = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id, selling_price, reorder_level)
         VALUES ($1, $2, 'Cream Rag', 'KG', $3, 2.5, 10) RETURNING id`,
        [w.companyId, `${w.tag}I`, group]
      );
      const loc = (name: string) =>
        w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, $3) RETURNING id`, [
          w.companyId,
          `${w.tag}${name}`,
          name,
        ]);
      const a = await loc("North");
      const b = await loc("South");
      await w.q(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
         VALUES ($1, $2, $4, 5, 2, 10), ($1, $3, $4, 0, 2, 0)`,
        [w.companyId, a, b, item]
      );
      const r = await runSchemaCompatibilityStockItemDetail({
        companyId: w.companyId,
        fmt,
        fmtDec,
        params: { queryType: "x", entityName: "cream" },
      });
      expect(r.table?.rows).toEqual([["North", "5.000", "2.000", "10.00"]]);
      expect(r.stats?.map((s) => s.value)).toEqual([
        `${w.tag}I`,
        "Rags",
        "KG",
        "2.500",
        "10.000 KG",
        "5.000 KG",
        "10.00",
      ]);
    }));
});

describe("container cost breakdown", () => {
  it("asks for a container and reports an unknown container", () =>
    withReportWorld(async (w) => {
      const base = { companyId: w.companyId, fmt, fmtDec };
      expect(await runSchemaCompatibilityContainerCostBreakdown({ ...base, params: { queryType: "x" } })).toMatchObject(
        { summary: "Please specify a container number." }
      );
      expect(
        await runSchemaCompatibilityContainerCostBreakdown({ ...base, params: { queryType: "x", entityName: "NOPE" } })
      ).toMatchObject({ summary: 'No container found matching "NOPE".' });
    }));

  it("shows only base totals for a bare container without a transporter", () =>
    withReportWorld(async (w) => {
      await container(w, await supplier(w, "Bare Supplier"), "B1");
      const r = await runSchemaCompatibilityContainerCostBreakdown({
        companyId: w.companyId,
        fmt,
        fmtDec,
        params: { queryType: "x", containerNumber: `${w.tag}B1` },
      });
      expect(r.subtitle).toBe("");
      expect(r.table?.rows).toEqual([
        ["Items Total", "USD", "80.00"],
        ["Charges Total", "USD", "20.00"],
        ["GRAND TOTAL", "USD", "100.00"],
      ]);
      expect(r.stats?.find((s) => s.label === "Total Kg")?.value).toBe("0.000");
    }));

  it("lists every fee and PO charge with transporter and agent", () =>
    withReportWorld(async (w) => {
      const sup = await supplier(w, "Full Supplier");
      const c = await container(w, sup, "F1", {
        transport: 7,
        duty: 3,
        transporter: "TransCo",
        agent: "Agent K",
        kg: 500,
      });
      await w.q(
        `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, currency, freight, fumigation, surcharge,
           document_charges, discount)
         VALUES ($1, $2, $3, $4, 'EUR', 11, 2, 4, 1, 5), ($1, $2, $5, $4, 'EUR', 0, 0, 0, 0, 0)`,
        [w.companyId, c, `${w.tag}P1`, sup, `${w.tag}P2`]
      );
      const r = await runSchemaCompatibilityContainerCostBreakdown({
        companyId: w.companyId,
        fmt,
        fmtDec,
        params: { queryType: "x", entityName: `${w.tag}F1` },
      });
      expect(r.subtitle).toBe("Transporter: TransCo · Agent: Agent K");
      const p1 = `${w.tag}P1`;
      expect(r.table?.rows).toEqual([
        ["Items Total", "EUR", "80.00"],
        ["Charges Total", "EUR", "20.00"],
        ["Transport Fee", "EUR", "7.00"],
        ["Duty Fee", "EUR", "3.00"],
        [`Freight (${p1})`, "EUR", "11.00"],
        [`Fumigation (${p1})`, "EUR", "2.00"],
        [`Surcharge (${p1})`, "EUR", "4.00"],
        [`Doc Charges (${p1})`, "EUR", "1.00"],
        [`Discount (${p1})`, "EUR", "(5.00)"],
        ["GRAND TOTAL", "EUR", "100.00"],
      ]);
    }));

  it("omits the agent when only a transporter is set", () =>
    withReportWorld(async (w) => {
      await container(w, await supplier(w, "Solo Supplier"), "T1", { transporter: "SoloTrans" });
      const r = await runSchemaCompatibilityContainerCostBreakdown({
        companyId: w.companyId,
        fmt,
        fmtDec,
        params: { queryType: "x", entityName: `${w.tag}T1` },
      });
      expect(r.subtitle).toBe("Transporter: SoloTrans");
    }));
});
