/**
 * POST /api/factory/payrolls/payment-summary-pdf
 * (server/routes/payroll/core/payment-summary-pdf.ts) over HTTP, one
 * rolled-back factory company per test. Refusals first: missing payroll ids,
 * unknown ids and another company's payrolls. Then real PDFs: header,
 * trailer, page objects, size growing with rows, fallbacks for workers that
 * are missing or have Arabic names, fractional and missing attendance.
 */
import { describe, expect, it } from "vitest";
import type { Response } from "superagent";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/payrolls/payment-summary-pdf";

function binary(res: Response, callback: (error: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
}

const pdf = (w: FactoryWorld, body: Record<string, unknown>) => w.agent.post(URL).send(body).buffer(true).parse(binary);

async function payroll(
  w: FactoryWorld,
  workerName: string | null,
  fields: { present?: string | null; absent?: string | null; net?: string; bonuses?: string; companyId?: number } = {}
) {
  const companyId = fields.companyId ?? w.companyId;
  const workerId = workerName
    ? await w.one(`INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id`, [
        companyId,
        workerName,
      ])
    : 2147483000;
  return w.one(
    `INSERT INTO factory_payrolls (company_id, worker_id, period_start, period_end, present_days, absent_days,
       net_salary, bonuses)
     VALUES ($1, $2, '2026-03-01', '2026-03-31', $3, $4, $5, $6) RETURNING id`,
    [companyId, workerId, fields.present ?? null, fields.absent ?? null, fields.net ?? "100", fields.bonuses ?? "0"]
  );
}

function expectPdf(body: Buffer) {
  expect(Buffer.isBuffer(body)).toBe(true);
  expect(body.subarray(0, 5).toString()).toBe("%PDF-");
  expect(body.subarray(-6).toString()).toMatch(/%%EOF\s*$/);
  const pages = body.toString("latin1").match(/\/Type \/Page\b/g) ?? [];
  return pages.length;
}

describe("payment summary PDF refusals", () => {
  it("refuses missing payroll ids, unknown ids and another company's payrolls", () =>
    withFactoryWorld(async (w) => {
      const missing = await w.agent.post(URL).send({});
      expect(missing.status).toBe(400);
      expect(missing.body.message).toBe("payrollIds required");
      expect((await w.agent.post(URL).send({ payrollIds: [] })).status).toBe(400);
      const unknown = await w.agent.post(URL).send({ payrollIds: [2147483000] });
      expect(unknown.status).toBe(404);
      expect(unknown.body.message).toBe("No payroll records found");

      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreign = await payroll(w, "Foreign Worker", { companyId: other });
      // The session company scopes the lookup: another company's payroll id is not found.
      expect((await w.agent.post(URL).send({ payrollIds: [foreign] })).status).toBe(404);
    }));

  it("refuses a request that names another company in the body", () =>
    withFactoryWorld(async (w) => {
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}P`]
      );
      const foreign = await payroll(w, "Foreign Worker", { companyId: other });
      const res = await w.agent.post(URL).send({ companyId: other, payrollIds: [foreign] });
      expect(res.status).toBe(403);
      expect(res.headers["content-type"]).not.toMatch(/pdf/);
    }));
});

describe("payment summary PDF", () => {
  it("renders a valid PDF for the selected payrolls", () =>
    withFactoryWorld(async (w) => {
      const ids = [
        await payroll(w, "Amani Kabila", { present: "26", absent: "0", net: "250.50", bonuses: "15" }),
        await payroll(w, "محمد علي", { present: "25.5", absent: "0.5", net: "199.99" }),
        await payroll(w, null, { net: "80" }),
      ];
      const res = await pdf(w, { payrollIds: ids });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-disposition"]).toBe('inline; filename="payment-summary.pdf"');
      expect(expectPdf(res.body)).toBe(1);
      expect(res.body.length).toBeGreaterThan(1500);

      const single = await pdf(w, { payrollIds: [ids[0]] });
      expect(expectPdf(single.body)).toBe(1);
      expect(single.body.length).toBeLessThan(res.body.length);
    }));

  it("renders a long payroll run across pages", () =>
    withFactoryWorld(async (w) => {
      const ids: number[] = [];
      for (let i = 0; i < 45; i++) ids.push(await payroll(w, `Worker ${i + 1}`, { present: "20", absent: "1" }));
      const res = await pdf(w, { payrollIds: ids });
      expect(res.status).toBe(200);
      expect(expectPdf(res.body)).toBeGreaterThan(1);
    }));
});
