/**
 * Factory worker statement JSON and PDF
 * (server/routes/payroll/worker-statement/statement.ts), against real rows in
 * one rolled-back transaction per test.
 *
 * Pinned: invalid ids and other-company workers are refused, the statement is
 * company-scoped and date-filtered, the running balance is exact, and the PDF
 * renders every period label, Arabic names and multi-page statements.
 */
import type request from "supertest";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

/** Collect a binary response body (ZIP/PDF/XLSX) as a Buffer. */
function binary(test: request.Test): request.Test {
  return test.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => callback(null, Buffer.concat(chunks)));
  });
}

async function worker(w: FactoryWorld, fullName = "Statement Worker", companyId = w.companyId) {
  return w.one(`INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id`, [
    companyId,
    fullName,
  ]);
}

async function advance(w: FactoryWorld, workerId: number, date: string, amount: string, notes: string | null = null) {
  await w.q(
    `INSERT INTO factory_worker_advances (company_id, worker_id, advance_date, amount, notes) VALUES ($1, $2, $3, $4, $5)`,
    [w.companyId, workerId, date, amount, notes]
  );
}

async function payroll(w: FactoryWorld, workerId: number, paidAt: string | null, net: string, status = "PAID") {
  await w.q(
    `INSERT INTO factory_payrolls (company_id, worker_id, period_start, period_end, net_salary, status, paid_at)
     VALUES ($1, $2, '2026-05-01', '2026-05-31', $3, $4, $5)`,
    [w.companyId, workerId, net, status, paidAt]
  );
}

const statement = (w: FactoryWorld, id: number | string, query = "") =>
  w.agent.get(`/api/factory/workers/${id}/statement${query}`);
const pdf = (w: FactoryWorld, id: number | string, query = "") =>
  binary(w.agent.get(`/api/factory/workers/${id}/statement-pdf${query}`));

describe("worker statement JSON", () => {
  it("rejects invalid ids and returns nothing for another company's worker", async () => {
    await withFactoryWorld(async (w) => {
      expect((await statement(w, "abc")).status).toBe(400);
      expect((await statement(w, "0")).status).toBe(400);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreign = await worker(w, "Foreign", other);
      await w.q(
        `INSERT INTO factory_worker_advances (company_id, worker_id, advance_date, amount) VALUES ($1, $2, '2026-05-02', 9)`,
        [other, foreign]
      );
      const res = await statement(w, foreign);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  it("merges advances and paid payrolls in date order with an exact running balance", async () => {
    await withFactoryWorld(async (w) => {
      const id = await worker(w);
      await advance(w, id, "2026-05-02", "10.10", "Tools");
      await advance(w, id, "2026-05-20", "0.20");
      await payroll(w, id, "2026-05-31T10:00:00Z", "5.15");
      await payroll(w, id, null, "99", "DRAFT");
      const res = await statement(w, id);
      expect(res.status).toBe(200);
      expect(
        res.body.map((e: { voucherType: string; narration: string; runningBalance: number }) => [
          e.voucherType,
          e.narration,
          e.runningBalance,
        ])
      ).toEqual([
        ["Advance", "Tools", 10.1],
        ["Advance", "Advance payment", 10.3],
        ["Payroll", "Payroll 2026-05-01 to 2026-05-31", 5.15],
      ]);

      const filtered = await statement(w, id, "?startDate=2026-05-10&endDate=2026-05-25");
      expect(filtered.body).toHaveLength(1);
      expect(filtered.body[0]).toMatchObject({ voucherType: "Advance", debitAmount: "0.20" });
    });
  });
});

describe("worker statement PDF", () => {
  it("rejects invalid ids and another company's worker", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.get(`/api/factory/workers/abc/statement-pdf`)).status).toBe(400);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreign = await worker(w, "Foreign", other);
      const res = await w.agent.get(`/api/factory/workers/${foreign}/statement-pdf`);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Worker not found");
    });
  });

  it("renders a statement for every period label", async () => {
    await withFactoryWorld(async (w) => {
      const id = await worker(w);
      await advance(w, id, "2026-05-02", "10");
      await payroll(w, id, "2026-05-31T10:00:00Z", "25");
      for (const query of [
        "",
        "?startDate=2026-05-01&endDate=2026-05-31",
        "?startDate=2026-05-01",
        "?endDate=2026-05-31",
      ]) {
        const res = await pdf(w, id, query);
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toBe("application/pdf");
        expect(res.headers["content-disposition"]).toContain("statement");
        expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
      }
    });
  });

  it("renders an Arabic-named worker across several pages in a non-USD company", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`UPDATE companies SET base_currency = 'CFA' WHERE id = $1`, [w.companyId]);
      const id = await worker(w, "عامل المصنع");
      for (let day = 1; day <= 70; day++) {
        const date = `2026-0${1 + Math.floor((day - 1) / 28)}-${String(((day - 1) % 28) + 1).padStart(2, "0")}`;
        await advance(w, id, date, "1000", day % 2 ? "سلفة" : null);
      }
      await payroll(w, id, "2026-04-15T10:00:00Z", "90000");
      const res = await pdf(w, id);
      expect(res.status).toBe(200);
      const body = res.body as Buffer;
      expect(body.subarray(0, 5).toString()).toBe("%PDF-");
      const pages = body.toString("latin1").match(/\/Type \/Page\b/g) ?? [];
      expect(pages.length).toBeGreaterThan(1);
    });
  });
});
