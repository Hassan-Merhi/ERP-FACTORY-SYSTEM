/**
 * Order-overview trip invoice lines, trip invoice workbook, audit history and
 * the full dashboard workbook (loadingDispatchOrderOverviewRoutes.ts) through
 * the real dispatch workflow in one rolled-back transaction: id, role,
 * company and filter refusals, unposted trips, frozen totals that no longer
 * reconcile, and the posted invoice and report workbooks.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closedTrip, dispatchBase, loadingWithBales, postedTrip } from "./helpers/dispatchFlowFixture";

const overview = (orderId: number | string) => `${dispatchBase(orderId as number)}/order-overview`;

function binary(res: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (e: Error | null, b: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c) => chunks.push(c!));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

async function sheet(w: FactoryWorld, url: string) {
  const res = await w.agent.get(url).buffer(true).parse(binary);
  expect(res.status).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body as unknown as ExcelJS.Buffer);
  return { wb, disposition: String(res.headers["content-disposition"]) };
}

describe("dispatch order overview routes: refusals", () => {
  it("refuses bad ids, non-finance roles, other companies and bad history filters", () =>
    withFactoryWorld(async (w) => {
      const { orderId } = await loadingWithBales(w, ["10.00"]);
      expect((await w.agent.get(`${overview("abc")}/history`)).body.code).toBe("DISPATCH_ORDER_ID_INVALID");
      expect((await w.agent.get(`${overview(orderId)}/trips/abc/invoice-lines`)).body.code).toBe(
        "DISPATCH_TRIP_ID_INVALID"
      );
      expect((await w.agent.get(`${overview(orderId)}/trips/abc/invoice.xlsx`)).body.code).toBe(
        "DISPATCH_TRIP_ID_INVALID"
      );
      const bad = async (query: string) => (await w.agent.get(`${overview(orderId)}/history?${query}`)).body.code;
      expect(await bad("source=other")).toBe("DISPATCH_HISTORY_FILTER_INVALID");
      expect(await bad("limit=0")).toBe("DISPATCH_HISTORY_LIMIT_INVALID");
      expect(await bad("dispatchId=abc")).toBe("DISPATCH_HISTORY_TRIP_INVALID");
      expect(await bad("dispatchId=1&dispatchId=2")).toBe("DISPATCH_HISTORY_TRIP_INVALID");
      expect(await bad(new URLSearchParams({ cursor: "x".repeat(300) }).toString())).toBe(
        "DISPATCH_HISTORY_CURSOR_INVALID"
      );
      expect(await bad("cursor=not-a-cursor")).toBe("HISTORY_CURSOR_INVALID");

      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const customer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Other') RETURNING id`,
        [other, `${w.tag}OC`]
      );
      const foreign = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, '2026-06-01', 'LOADING') RETURNING id`,
        [other, customer]
      );
      expect((await w.agent.get(`${overview(foreign)}/history`)).status).toBe(404);
      expect((await w.agent.get(`${overview(foreign)}/report.xlsx`)).status).toBe(404);
      expect((await w.agent.get(`${overview(foreign)}/trips/1/invoice-lines`)).body.code).toBe(
        "DISPATCH_TRIP_NOT_POSTED"
      );

      const manager = await w.agentFor("Manager");
      const denied = await manager.get(`${overview(orderId)}/history`);
      expect([denied.status, denied.body.code]).toEqual([403, "DISPATCH_REPORT_FINANCE_ROLE_REQUIRED"]);
    }));

  it("refuses invoice exports for a trip that is closed but not financially posted", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"]);
      const tripId = await closedTrip(w, orderId, [bales[0].reference]);
      const lines = await w.agent.get(`${overview(orderId)}/trips/${tripId}/invoice-lines`);
      expect([lines.status, lines.body.code]).toEqual([409, "DISPATCH_TRIP_NOT_POSTED"]);
      const xlsx = await w.agent.get(`${overview(orderId)}/trips/${tripId}/invoice.xlsx`);
      expect([xlsx.status, xlsx.body.code]).toEqual([409, "DISPATCH_TRIP_NOT_POSTED"]);
    }));
});

describe("dispatch order overview routes: posted trip", () => {
  it("lists frozen invoice lines and writes the trip invoice workbook", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00", "12.50"]);
      const { dispatchId } = await postedTrip(
        w,
        orderId,
        bales.map((b) => b.reference)
      );
      const lines = await w.agent.get(`${overview(orderId)}/trips/${dispatchId}/invoice-lines`);
      expect(lines.status).toBe(200);
      expect(lines.body.goodsSubtotal).toBe("22.50");
      expect(lines.body.lines).toHaveLength(2);

      const { wb, disposition } = await sheet(w, `${overview(orderId)}/trips/${dispatchId}/invoice.xlsx`);
      expect(disposition).toMatch(/Factory_Trip_Invoice/);
      const ws = wb.getWorksheet("Trip Invoice")!;
      expect(ws.getCell("A1").value).toBe(w.tag);
      expect(ws.getCell("B6").value).toBe(orderId);
      const flat = ws.getSheetValues().flat().map(String);
      expect(flat).toContain("GOODS SUBTOTAL");
      expect(flat).toContain("TOTAL CUSTOMER RECEIVABLE (USD)");

      const history = await w.agent.get(
        `${overview(orderId)}/history?source=physical&limit=5&dispatchId=${dispatchId}`
      );
      expect(history.status).toBe(200);
      expect(Array.isArray(history.body.entries)).toBe(true);

      const report = await sheet(w, `${overview(orderId)}/report.xlsx`);
      expect(report.disposition).toMatch(/Factory_Dispatch_Overview/);
      expect(report.wb.worksheets.length).toBeGreaterThan(0);
    }));

  it("refuses an invoice whose frozen lines or totals no longer reconcile", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"]);
      const { dispatchId } = await postedTrip(w, orderId, [bales[0].reference]);
      const url = `${overview(orderId)}/trips/${dispatchId}/invoice.xlsx`;
      await w.q(`SET LOCAL session_replication_role = replica`);
      // The total-math check constraint keeps DISPATCH_INVOICE_TOTAL_MISMATCH
      // unreachable, so only the goods-versus-lines check can be driven.
      await w.q(
        `UPDATE factory_dispatch_trip_financials
            SET goods_subtotal = goods_subtotal + 1, customer_total = customer_total + 1 WHERE dispatch_id = $1`,
        [dispatchId]
      );
      expect((await w.agent.get(url)).body.code).toBe("DISPATCH_INVOICE_GOODS_MISMATCH");
      await w.q(`DELETE FROM factory_dispatch_trip_financial_bales WHERE dispatch_id = $1`, [dispatchId]);
      const lines = await w.agent.get(`${overview(orderId)}/trips/${dispatchId}/invoice-lines`);
      expect(lines.body.code).toBe("DISPATCH_TRIP_LINES_MISSING");
      await w.q(`SET LOCAL session_replication_role = origin`);
    }));
});
