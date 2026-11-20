/**
 * Stock Entry History PDF export
 * (server/routes/factory/bales/registerBalesReportRoutesPart3.ts) over HTTP in
 * one rolled-back factory company per test: date-range and default-today
 * periods, every filter, privileged reference search across all dates (which
 * includes deleted bales), the non-privileged search (which does not), the
 * unassigned-worker filter, unnamed groups, and page breaks for group rows,
 * bale rows and the totals footer. The PDF's page count shows the breaks.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const ROUTE = "/api/factory/bales/stock-entry-history/export-pdf";

const pdf = (agent: FactoryWorld["agent"], filters: Record<string, string>) =>
  agent
    .get(`${ROUTE}?${new URLSearchParams(filters)}`)
    .buffer(true)
    .parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => done(null, Buffer.concat(chunks)));
    });

const pages = (body: Buffer) => (body.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

async function world(w: FactoryWorld) {
  const workerId = await w.one(
    `INSERT INTO factory_workers (company_id, full_name, active) VALUES ($1, 'Presser', TRUE) RETURNING id`,
    [w.companyId]
  );
  const productId = await w.one(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code) VALUES ($1, $2, 'Shoes', 'SH-1') RETURNING id`,
    [w.companyId, `${w.tag}P`]
  );
  const bales = (
    count: number,
    date: string,
    worker: number | null,
    product: number | null,
    location: number | null,
    status = "IN_STOCK",
    prefix = "REF"
  ) =>
    w.q(
      `INSERT INTO factory_bales (company_id, reference_number, bale_code, weight_kg, status, finalized_by, product_id,
         erp_location_id, stock_entry_date, finalized_at)
       SELECT $1, $2 || '-' || g, $2 || '-' || g, 25.5, $3, $4, $5, $6, $7::date, $7::date + g * interval '1 minute'
         FROM generate_series(1, $8::int) g`,
      [w.companyId, `${w.tag}${prefix}${date}`, status, worker, product, location, date, count]
    );
  return { workerId, productId, bales };
}

describe("stock entry history PDF", () => {
  it("renders a multi-page export with group, bale and footer page breaks", () =>
    withFactoryWorld(async (w) => {
      const { workerId, productId, bales } = await world(w);
      // 48 bale rows fill page 1 and 62 more end page 2 at y = 784, so the
      // next (older) group row and, when filtered alone, the footer break.
      await bales(110, "2026-03-25", workerId, productId, w.locationId);
      for (let day = 3; day <= 20; day++) {
        await bales(1, `2026-03-${String(day).padStart(2, "0")}`, null, null, null);
      }
      const res = await pdf(w.agent, { startDate: "2026-03-01", endDate: "2026-03-31" });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-disposition"]).toContain("stock-entry-history-2026-03-01-to-2026-03-31.pdf");
      expect(pages(res.body)).toBeGreaterThanOrEqual(3);

      const filtered = await pdf(w.agent, {
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        workerId: String(workerId),
        productId: String(productId),
        locationId: String(w.locationId),
        status: "IN_STOCK",
        includeUnassigned: "false",
      });
      expect(filtered.status).toBe(200);
      expect(pages(filtered.body)).toBeGreaterThanOrEqual(2);
    }));

  it("defaults to today and renders an empty report", () =>
    withFactoryWorld(async (w) => {
      const res = await pdf(w.agent, {});
      expect(res.status).toBe(200);
      expect(res.body.subarray(0, 4).toString()).toBe("%PDF");
      expect(res.headers["content-disposition"]).toMatch(
        /stock-entry-history-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.pdf/
      );
      expect(pages(res.body)).toBe(1);
    }));

  it("searches references across all dates for privileged roles and within the range when dated", () =>
    withFactoryWorld(async (w) => {
      const { workerId, bales } = await world(w);
      await bales(2, "2025-01-10", workerId, null, null, "DELETED", "OLD");
      await bales(1, "2026-03-05", workerId, null, null, "IN_STOCK", "NEW");
      const all = await pdf(w.agent, { search: "old" });
      expect(all.status).toBe(200);
      const dated = await pdf(w.agent, { search: "old", startDate: "2026-03-01" });
      expect(dated.status).toBe(200);
      expect(all.body.length).toBeGreaterThan(dated.body.length);

      const clerk = await w.agentFor("Supervisor");
      const limited = await pdf(clerk, { search: "old" });
      expect(limited.status).toBe(200);
      expect(limited.body.length).toBeLessThan(all.body.length);
    }));
});
