/**
 * Factory container Excel import (JSON rows): each refused row is reported
 * with its reason and creates nothing, while valid rows in the same request
 * import (new supplier created once and reused, commission, recorded or
 * manual non-USD rate). One rolled-back transaction per test.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/containers/import-excel";

describe("factory container Excel import", () => {
  it("refuses an empty or missing row list", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.post(URL).send({ rows: [] })).body).toEqual({ message: "No rows to import" });
      expect((await w.agent.post(URL).send({})).status).toBe(400);
    });
  });

  it("reports each invalid row and imports the valid ones", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(
        `INSERT INTO factory_fx_rates (company_id, currency_code, effective_date, rate_to_usd, source) VALUES ($1, 'EUR', '2026-01-01', 1.1, 'manual')`,
        [w.companyId]
      );
      const c = (suffix: string) => `${w.tag}${suffix}`;
      const res = await w.agent.post(URL).send({
        rows: [
          { containerNumber: "  " },
          { containerNumber: c("S"), status: "LOST" },
          { containerNumber: c("C"), currencyCode: "JPY" },
          { containerNumber: c("K"), totalKg: "abc" },
          { containerNumber: c("R"), ratePerKg: "x" },
          { containerNumber: c("M"), currencyCode: "EUR", fxSource: "manual" },
          { containerNumber: c("Z"), currencyCode: "EUR", fxSource: "manual", fxRateToUsd: "0" },
          { containerNumber: c("G"), currencyCode: "GBP", arrivalDate: "2026-02-01" },
          {
            containerNumber: c("A"),
            supplierName: ` ${w.tag} New Supplier `,
            totalKg: "1000",
            ratePerKg: "0.5",
            arrivalDate: "2026-02-01",
            commissionAmount: "25",
            commissionCurrencyCode: "usd",
            status: "in_transit",
            origin: "UK",
            notes: "first",
          },
          {
            containerNumber: c("B"),
            supplierName: `${w.tag} new supplier`,
            currencyCode: "eur",
            ratePerKg: "2",
            arrivalDate: "2026-02-01",
          },
          {
            containerNumber: c("D"),
            currencyCode: "EUR",
            fxSource: "MANUAL",
            fxRateToUsd: "1.25",
            ratePerKg: "1",
            arrivalDate: "2026-02-01",
          },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(11);
      expect(res.body.imported).toBe(3);
      expect(res.body.errors).toEqual([
        "Row 1: Missing container number",
        expect.stringContaining(`Row 2 (${c("S")}): Invalid status "LOST"`),
        `Row 3 (${c("C")}): Invalid currency "JPY"`,
        `Row 4 (${c("K")}): Invalid Total Kg value`,
        `Row 5 (${c("R")}): Invalid Rate/Kg value`,
        `Row 6 (${c("M")}): fxSource is MANUAL but fxRateToUsd was not provided`,
        `Row 7 (${c("Z")}): Invalid manual fxRateToUsd for EUR`,
        expect.stringContaining(`Row 8 (${c("G")}):`),
      ]);

      const rows = await w.q(
        `SELECT fc.container_number, fc.status, fc.currency_code, fc.fx_rate_to_usd::numeric AS fx,
                fc.rate_per_kg_usd::numeric AS usd, fc.fx_rate_source, fc.commission_amount::numeric AS comm,
                fs.name AS supplier
           FROM factory_containers fc LEFT JOIN factory_suppliers fs ON fs.id = fc.supplier_id
          WHERE fc.company_id = $1 ORDER BY fc.container_number`,
        [w.companyId]
      );
      expect(
        rows.map((r) => [r.container_number, r.status, r.currency_code, Number(r.fx), Number(r.usd), r.fx_rate_source])
      ).toEqual([
        [c("A"), "IN_TRANSIT", "USD", 1, 0.5, "auto"],
        [c("B"), "PENDING", "EUR", 1.1, 2.2, "auto"],
        [c("D"), "PENDING", "EUR", 1.25, 1.25, "manual"],
      ]);
      expect(Number(rows[0].comm)).toBe(25);
      expect(rows[0].supplier).toBe(`${w.tag} New Supplier`);
      expect(rows[1].supplier).toBe(`${w.tag} New Supplier`);
      const suppliers = await w.q(`SELECT id FROM factory_suppliers WHERE company_id = $1`, [w.companyId]);
      expect(suppliers).toHaveLength(1);
      const daybook = await w.q(
        `SELECT 1 FROM factory_daybook_entries WHERE company_id = $1 AND tx_type = 'CONTAINER_IMPORT'`,
        [w.companyId]
      );
      expect(daybook).toHaveLength(3);
    });
  });

  it("reports a duplicate container number as a row error without aborting the batch", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`INSERT INTO factory_containers (company_id, container_number) VALUES ($1, $2)`, [
        w.companyId,
        `${w.tag}DUP`,
      ]);
      const res = await w.agent.post(URL).send({
        rows: [{ containerNumber: `${w.tag}DUP` }, { containerNumber: `${w.tag}OK` }],
      });
      expect(res.status).toBe(200);
      expect(res.body.imported).toBe(1);
      expect(res.body.errors).toEqual([expect.stringMatching(new RegExp(`^Row 1 \\(${w.tag}DUP\\): `))]);
      const rows = await w.q(`SELECT container_number FROM factory_containers WHERE company_id = $1 ORDER BY id`, [
        w.companyId,
      ]);
      expect(rows.map((r) => r.container_number)).toEqual([`${w.tag}DUP`, `${w.tag}OK`]);
    });
  });
});
