/**
 * PATCH /api/factory/daybook/:entryId/cost-edit against PostgreSQL in one
 * rolled-back transaction per test: each container cost source the entry can
 * point at is rewritten, container costs are recalculated, the container's
 * offload entry is re-totalled and an edit audit row is kept. Refusals change
 * nothing.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const edit = (w: FactoryWorld, entryId: number | string, body: Record<string, unknown>, agent = w.agent) =>
  agent.patch(`/api/factory/daybook/${entryId}/cost-edit`).send(body);

let containerSeq = 0;

async function container(w: FactoryWorld, fields: Record<string, unknown> = {}) {
  const supplierId = await w.one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
    w.companyId,
    ` Rag Supplier ${++containerSeq} `,
  ]);
  const defaults: Record<string, unknown> = {
    company_id: w.companyId,
    container_number: `${w.tag}-CNT`,
    supplier_id: supplierId,
    actual_received_kg: "1000",
    rate_per_kg: "0.5",
    currency_code: "USD",
    fx_rate_to_usd: "1",
    fx_rate_confirmed: true,
    freight: "100",
    duty_status: "CONFIRMED",
    duty_amount: "50",
    other_charges: "0",
    commission_amount: "0",
    status: "OFFLOADED",
    ...fields,
  };
  const cols = Object.keys(defaults);
  const id = await w.one(
    `INSERT INTO factory_containers (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    cols.map((c) => defaults[c])
  );
  const rawStockId = await w.one(
    `INSERT INTO factory_raw_stock (company_id, container_id) VALUES ($1, $2) RETURNING id`,
    [w.companyId, id]
  );
  const offloadEntry = await entry(w, "OFFLOAD_RAW_STOCK", rawStockId, null);
  return { id, rawStockId, offloadEntry };
}

function entry(
  w: FactoryWorld,
  txType: string,
  referenceId: number | null,
  meta: Record<string, unknown> | null | string,
  currency = "USD",
  fx = "1"
) {
  return w.one(
    `INSERT INTO factory_daybook_entries (company_id, tx_date, tx_type, description, reference_id, meta_json,
       currency_code, fx_rate_to_usd, amount_currency, amount_usd)
     VALUES ($1, '2026-05-01', $2, 'cost', $3, $4, $5, $6, 1, 1) RETURNING id`,
    [
      w.companyId,
      txType,
      referenceId,
      meta === null ? null : typeof meta === "string" ? meta : JSON.stringify(meta),
      currency,
      fx,
    ]
  );
}

const containerRow = async (w: FactoryWorld, id: number) =>
  (
    await w.q(
      `SELECT rate_per_kg::text AS rate, freight::text AS freight, duty_amount::text AS duty,
         other_charges::text AS other, commission_amount::text AS commission, currency_code
       FROM factory_containers WHERE id = $1`,
      [id]
    )
  )[0];
const entryRow = async (w: FactoryWorld, id: number) =>
  (
    await w.q(
      `SELECT amount_currency::text AS amount, amount_usd::text AS usd, currency_code, meta_json, description
       FROM factory_daybook_entries WHERE id = $1`,
      [id]
    )
  )[0];

describe("daybook cost edit: container sources", () => {
  it("re-rates base material from the offload entry and audits the edit", async () => {
    await withFactoryWorld(async (w) => {
      const c = await container(w);
      const res = await edit(w, c.offloadEntry, { newAmount: "800", reason: "  supplier credit  " });
      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/New inclusive cost/);
      expect((await containerRow(w, c.id)).rate).toBe("0.800000");
      const updated = await entryRow(w, c.offloadEntry);
      expect(updated.amount).toBe("800.00");
      expect(JSON.parse(updated.meta_json)).toMatchObject({ containerId: c.id, sourceType: "OFFLOAD_RAW_STOCK" });
      const audits = await w.q(`SELECT reason FROM factory_daybook_entry_edits WHERE daybook_entry_id = $1`, [
        c.offloadEntry,
      ]);
      expect(audits).toEqual([{ reason: "supplier credit" }]);
    });
  });

  it("updates freight (with a new currency and rate), duty and other charges, re-totalling the offload entry", async () => {
    await withFactoryWorld(async (w) => {
      const c = await container(w);
      const freight = await entry(w, "FREIGHT", c.id, null);
      const res = await edit(w, freight, {
        newAmount: "120",
        reason: "invoice",
        newCurrencyCode: "EUR",
        newFxRate: "1.1",
      });
      expect(res.status).toBe(200);
      expect((await containerRow(w, c.id)).freight).toBe("120.00");
      expect(await entryRow(w, freight)).toMatchObject({ amount: "120.00", usd: "132.00", currency_code: "EUR" });
      expect((await entryRow(w, c.offloadEntry)).description).toMatch(/Rag Supplier.*\[edited\]$/);

      const duty = await entry(w, "DUTY", null, { containerId: c.id });
      expect((await edit(w, duty, { newAmount: "75", reason: "duty fix" })).status).toBe(200);
      expect((await containerRow(w, c.id)).duty).toBe("75.00");
      const dutyLog = await w.q(
        `SELECT new_duty_amount::text AS amt FROM factory_duty_audit_log WHERE container_id = $1`,
        [c.id]
      );
      expect(dutyLog).toEqual([{ amt: "75.00" }]);

      const other = await entry(w, "OTHER_CHARGE", c.id, "not json");
      expect((await edit(w, other, { newAmount: "9", reason: "legacy other" })).status).toBe(200);
      expect((await containerRow(w, c.id)).other).toBe("9.00");
      const oc = await entry(w, "OTHER_CHARGE", c.id, { sourceType: "CONTAINER_OC" });
      expect((await edit(w, oc, { newAmount: "11", reason: "container oc" })).status).toBe(200);
      expect((await containerRow(w, c.id)).other).toBe("11.00");
    });
  });

  it("updates an additional offload charge and a commission", async () => {
    await withFactoryWorld(async (w) => {
      const c = await container(w);
      const chargeId = await w.one(
        `INSERT INTO factory_offload_additional_charges (company_id, container_id, description, amount) VALUES ($1, $2, 'Labour', 10) RETURNING id`,
        [w.companyId, c.id]
      );
      const extra = await entry(w, "OTHER_CHARGE", c.id, { sourceType: "OFFLOAD_ADDITIONAL", chargeId });
      expect((await edit(w, extra, { newAmount: "14", reason: "labour" })).status).toBe(200);
      const [charge] = await w.q(
        `SELECT amount::text AS amount FROM factory_offload_additional_charges WHERE id = $1`,
        [chargeId]
      );
      expect(charge.amount).toBe("14.00");
      const noCharge = await entry(w, "OTHER_CHARGE", c.id, { sourceType: "POST_OFFLOAD_ADDITIONAL" });
      const missing = await edit(w, noCharge, { newAmount: "14", reason: "labour" });
      expect(missing.status).toBe(500);
      expect(missing.body.message).toMatch(/Missing chargeId/);

      const commissionId = await w.one(
        `INSERT INTO factory_container_commissions (company_id, container_id, person_name, commission_rate, commission_total)
         VALUES ($1, $2, 'Agent', 1, 5) RETURNING id`,
        [w.companyId, c.id]
      );
      const commission = await entry(w, "COMMISSION", commissionId, null);
      const res = await edit(w, commission, { newAmount: "6", reason: "agent fee" });
      expect(res.status).toBe(200);
      expect((await containerRow(w, c.id)).commission).toBe("6.00");
      const [row] = await w.q(
        `SELECT commission_total::text AS total FROM factory_container_commissions WHERE id = $1`,
        [commissionId]
      );
      expect(row.total).toBe("6.0000");
    });
  });
});

describe("daybook cost edit: refusals", () => {
  it("validates role, id, reason, amount and rate", async () => {
    await withFactoryWorld(async (w) => {
      const c = await container(w);
      const manager = await w.agentFor("Manager");
      expect((await edit(w, c.offloadEntry, { newAmount: "1", reason: "r" }, manager)).status).toBe(403);
      expect((await edit(w, "abc", { newAmount: "1", reason: "r" })).status).toBe(400);
      expect((await edit(w, c.offloadEntry, { newAmount: "1", reason: " " })).body.message).toMatch(
        /reason is required/
      );
      expect((await edit(w, c.offloadEntry, { newAmount: "-1", reason: "r" })).body.message).toMatch(/non-negative/);
      expect((await edit(w, c.offloadEntry, { newAmount: "1", reason: "r", newFxRate: "x" })).body.message).toBe(
        "Invalid amount"
      );
      expect((await edit(w, 999999999, { newAmount: "1", reason: "r" })).status).toBe(404);
      const sale = await entry(w, "SALE", null, null);
      expect((await edit(w, sale, { newAmount: "1", reason: "r" })).body.message).toMatch(/not a cost entry/);
      expect((await entryRow(w, c.offloadEntry)).amount).toBe("1.00");
    });
  });

  it("refuses unresolvable containers, pending duty, unrated foreign currency and empty containers", async () => {
    await withFactoryWorld(async (w) => {
      const orphanCommission = await entry(w, "COMMISSION", 999999999, null);
      expect((await edit(w, orphanCommission, { newAmount: "1", reason: "r" })).body.message).toMatch(
        /Cannot resolve container/
      );
      const orphanOffload = await entry(w, "OFFLOAD_RAW_STOCK", 999999999, null);
      expect((await edit(w, orphanOffload, { newAmount: "1", reason: "r" })).status).toBe(400);
      const missing = await entry(w, "FREIGHT", 999999999, null);
      expect((await edit(w, missing, { newAmount: "1", reason: "r" })).status).toBe(404);

      const pending = await container(w, { duty_status: "PENDING", container_number: `${w.tag}-P` });
      const duty = await entry(w, "DUTY", pending.id, null);
      const dutyRes = await edit(w, duty, { newAmount: "5", reason: "r" });
      expect(dutyRes.status).toBe(500);
      expect(dutyRes.body.message).toMatch(/CONFIRMED/);
      expect((await containerRow(w, pending.id)).duty).toBe("50.00");

      const eur = await container(w, {
        container_number: `${w.tag}-E`,
        currency_code: "EUR",
        fx_rate_to_usd: "1",
        fx_rate_confirmed: false,
      });
      const eurFreight = await entry(w, "FREIGHT", eur.id, null, "EUR", "1");
      const unrated = await edit(w, eurFreight, { newAmount: "5", reason: "r" });
      expect(unrated.status).toBe(400);
      expect((await containerRow(w, eur.id)).freight).toBe("100.00");

      const empty = await container(w, { container_number: `${w.tag}-0`, actual_received_kg: "0" });
      const emptyRes = await edit(w, empty.offloadEntry, { newAmount: "5", reason: "r" });
      expect(emptyRes.body.message).toMatch(/no received weight/);
    });
  });
});
