/**
 * Supplier usage report over HTTP against a rolled-back company: input
 * refusals, empty PDF/Excel when no container matches, and full PDF and
 * Excel reports built from opening and in-period receipts, mix usage and
 * bales (finalised, unfinalised and out-of-period), filtered by supplier or
 * covering containers without one. Each generated report writes a daybook row.
 * The route sits behind the Developer-only Supplier Intel page.
 */
import { describe, expect, it } from "vitest";

import { type FactoryWorld, withFactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/reports/supplier-usage";
const PERIOD = { startDate: "2026-01-01", endDate: "2099-12-31" };

function binary(res: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (e: null, b: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk?: Buffer) => chunks.push(chunk as Buffer));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

async function seed(w: FactoryWorld) {
  const supplier = await w.one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
    w.companyId,
    `${w.tag} Supplier`,
  ]);
  const container = (number: string, supplierId: number | null) =>
    w.one(
      `INSERT INTO factory_containers (company_id, container_number, supplier_id) VALUES ($1, $2, $3) RETURNING id`,
      [w.companyId, `${w.tag}${number}`, supplierId]
    );
  const c1 = await container("C1", supplier);
  const c2 = await container("C2", null);
  const c3 = await container("C3", supplier);
  const stock = (containerId: number, received: string, used: string, usd: string, native: string, at: string | null) =>
    w.q(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg_usd, cost_per_kg, offloaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [w.companyId, containerId, received, used, usd, native, at]
    );
  await stock(c1, "100", "40", "0.5", "0", "2025-06-01");
  await stock(c3, "200", "0", "0", "0.7", "2026-03-01");
  await stock(c2, "50", "0", "0", "0", null);
  const mix = await w.one(
    `INSERT INTO factory_mix_batches (company_id, batch_code, status, total_weight_kg, used_kg) VALUES ($1, $2, 'COMPLETED', 30, 30) RETURNING id`,
    [w.companyId, `${w.tag}MB`]
  );
  await w.q(
    `INSERT INTO factory_mix_batch_sources (mix_batch_id, container_id, supplier_id, weight_kg, cost_per_kg, total_cost)
     VALUES ($1, $2, $3, 30, 0.5, 15)`,
    [mix, c1, supplier]
  );
  const bale = (ref: string, finalized: string | null) =>
    w.q(
      `INSERT INTO factory_bales (company_id, reference_number, mix_batch_id, weight_kg, cost_per_kg, total_cost, finalized_at)
       VALUES ($1, $2, $3, 10, 0.5, 5, $4)`,
      [w.companyId, `${w.tag}${ref}`, mix, finalized]
    );
  await bale("B1", "2026-03-02");
  await bale("B2", null);
  await bale("B3", "2025-01-01");
  return { supplier, c1, c2 };
}

const reports = async (w: FactoryWorld) =>
  w.q(`SELECT description FROM factory_daybook_entries WHERE company_id = $1 AND tx_type = 'REPORT_GENERATED'`, [
    w.companyId,
  ]);

describe("supplier usage report", () => {
  it("refuses missing inputs, an unknown format and an unknown company", async () => {
    await withFactoryWorld(async (w) => {
      await w.setRole("Developer");
      let res = await w.agent.post(URL).send({ companyId: w.companyId, startDate: "2026-01-01" });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("companyId, startDate, and endDate are required");
      res = await w.agent.post(URL).send({ companyId: w.companyId, ...PERIOD, format: "csv" });
      expect(res.body.message).toBe("format must be 'pdf' or 'excel'");
      res = await w.agent.post(URL).send({ companyId: 999999999, ...PERIOD, format: "pdf" });
      expect([403, 404]).toContain(res.status);
      expect(await reports(w)).toHaveLength(0);
    });
  });

  it("answers an empty PDF and Excel when no container matches", async () => {
    await withFactoryWorld(async (w) => {
      await w.setRole("Developer");
      const pdf = await w.agent
        .post(URL)
        .send({ companyId: w.companyId, ...PERIOD, format: "pdf" })
        .buffer(true)
        .parse(binary);
      expect(pdf.status).toBe(200);
      expect(pdf.headers["content-type"]).toContain("pdf");
      const xlsx = await w.agent
        .post(URL)
        .send({ companyId: w.companyId, ...PERIOD, format: "excel" })
        .buffer(true)
        .parse(binary);
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers["content-type"]).toContain("spreadsheet");
      expect(await reports(w)).toHaveLength(0);
    });
  });

  it("builds the full PDF and Excel reports and records each in the daybook", async () => {
    await withFactoryWorld(async (w) => {
      await w.setRole("Developer");
      const { supplier } = await seed(w);
      const pdf = await w.agent
        .post(URL)
        .send({ companyId: w.companyId, ...PERIOD, format: "pdf" })
        .buffer(true)
        .parse(binary);
      expect(pdf.status).toBe(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
      const xlsx = await w.agent
        .post(URL)
        .send({ companyId: w.companyId, supplierId: supplier, ...PERIOD, format: "excel" })
        .buffer(true)
        .parse(binary);
      expect(xlsx.status).toBe(200);
      expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe("PK");
      const descriptions = (await reports(w)).map((r) => String(r.description)).sort();
      expect(descriptions).toEqual([
        `Supplier Usage Report (EXCEL) – 2026-01-01 to 2099-12-31 – ${w.tag} Supplier`,
        "Supplier Usage Report (PDF) – 2026-01-01 to 2099-12-31 – All Suppliers",
      ]);
    });
  });

  it("is a Developer-only Supplier Intel page", async () => {
    await withFactoryWorld(async (w) => {
      await w.setRole("Admin");
      const res = await w.agent.post(URL).send({ companyId: w.companyId, ...PERIOD, format: "pdf" });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FACTORY_ROLE_ACCESS_DENIED");
    });
  });
});
