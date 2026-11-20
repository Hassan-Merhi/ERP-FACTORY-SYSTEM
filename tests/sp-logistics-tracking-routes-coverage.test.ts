/**
 * PATCH /api/git/sp-containers/:id/tracking: Supplier Partner logistics edits
 * through GIT. Pins every refusal (bad id/body, lifecycle fields, statuses,
 * missing, closed, other company, role) and that nothing is written on refusal.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function spContainer(w: FactoryWorld, companyId = w.companyId, status = "open") {
  return w.one(
    `INSERT INTO sp_containers (company_id, invoice_date, invoice_number, supplier_name, container_number, status)
     VALUES ($1, '2026-01-10', $2, 'Partner Co', $2, $3) RETURNING id`,
    [companyId, `${w.tag}-${Math.floor(Math.random() * 1e9)}`, status]
  );
}

const tracking = (w: FactoryWorld, id: number) =>
  w.q(`SELECT * FROM sp_container_git_tracking WHERE container_id = $1`, [id]);
const patch = (w: FactoryWorld, id: number | string, body: Record<string, unknown>) =>
  w.agent.patch(`/api/git/sp-containers/${id}/tracking`).send(body);

describe("SP GIT tracking refusals", () => {
  it("refuses bad ids, bad bodies, lifecycle fields and inactive statuses without writing", async () => {
    await withFactoryWorld(async (w) => {
      const id = await spContainer(w);
      expect((await patch(w, "abc", {})).status).toBe(400);
      expect((await patch(w, 0, {})).status).toBe(400);
      const invalid = await patch(w, id, { shopName: 5 });
      expect(invalid.status).toBe(400);
      expect(invalid.body.message).toBe("Invalid tracking data");
      expect((await patch(w, id, { offloadDate: "2026-02-01" })).body.message).toContain("Offload and automated ETA");
      expect((await patch(w, id, { etaSource: "manual" })).status).toBe(400);
      const status = await patch(w, id, { status: "Offloaded" });
      expect(status.status).toBe(400);
      expect(status.body.message).toContain("Only active logistics statuses");
      expect(await tracking(w, id)).toEqual([]);
    });
  });

  it("answers 404 for a missing container and 409 for a closed one", async () => {
    await withFactoryWorld(async (w) => {
      expect((await patch(w, 2147483000, { shopName: "x" })).status).toBe(404);
      const closed = await spContainer(w, w.companyId, "offloaded");
      const res = await patch(w, closed, { shopName: "x" });
      expect(res.status).toBe(409);
      expect(await tracking(w, closed)).toEqual([]);
    });
  });

  it("refuses another company's container and non-admin roles", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreign = await spContainer(w, other);
      const res = await patch(w, foreign, { shopName: "hijack" });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("COMPANY_ACCESS_DENIED");
      expect(await tracking(w, foreign)).toEqual([]);

      const own = await spContainer(w);
      const manager = await w.agentFor("Manager");
      expect((await manager.patch(`/api/git/sp-containers/${own}/tracking`).send({ shopName: "x" })).status).toBe(403);
      expect(await tracking(w, own)).toEqual([]);
    });
  });

  it("refuses invalid dates, charges and over-long text with 400 and writes nothing", async () => {
    await withFactoryWorld(async (w) => {
      const id = await spContainer(w);
      for (const [body, code] of [
        [{ eta: "10/01/2026" }, "INVALID_TRACKING_DATE"],
        [{ borderDate: "2026-02-30" }, "INVALID_TRACKING_DATE"],
        [{ transportFee: "-5" }, "INVALID_LOGISTICS_CHARGE"],
        [{ dutyFee: "abc" }, "INVALID_LOGISTICS_CHARGE"],
        [{ trackingDescription: "x".repeat(2001) }, "TRACKING_VALUE_TOO_LONG"],
        [{ shopName: "valid", transportFee: "-1" }, "INVALID_LOGISTICS_CHARGE"],
      ] as const) {
        const res = await patch(w, id, body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(code);
        expect(res.body.message).toMatch(new RegExp(Object.keys(body).at(-1)!));
      }
      expect(await tracking(w, id)).toEqual([]);
    });
  });
});

describe("SP GIT tracking updates", () => {
  it("returns ok without writing when nothing is supplied", async () => {
    await withFactoryWorld(async (w) => {
      const id = await spContainer(w);
      const res = await patch(w, id, {});
      expect(res.body).toEqual({ ok: true });
      expect(await tracking(w, id)).toEqual([]);
    });
  });

  it("normalizes every logistics field and the status", async () => {
    await withFactoryWorld(async (w) => {
      const id = await spContainer(w);
      const res = await patch(w, id, {
        shopName: "Shop 4",
        eta: "2026-03-01",
        transporter: "",
        transportFee: "12.5",
        numberPlate: "T123ABC",
        trackingLocation: "Tunduma",
        borderDate: null,
        agent: "Clearing Ltd",
        dutyFee: "300",
        docReceived: true,
        trackingDescription: "At the border",
        blDocs: "BL-1",
        docsSentDate: "2026-02-20",
        trackingLink: "https://track.example/1",
        freightStatus: "Pending",
        status: "At Border",
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, containerId: id });
      const [row] = await tracking(w, id);
      expect(row).toMatchObject({
        company_id: w.companyId,
        shop_name: "Shop 4",
        transporter: null,
        transport_fee: "12.5000",
        border_date: null,
        duty_fee: "300.0000",
        doc_received: true,
        freight_status: "Pending",
        status: "At Border",
      });

      const second = await patch(w, id, { status: null, transportFee: null, docReceived: false });
      expect(second.status).toBe(200);
      const [after] = await tracking(w, id);
      expect(after).toMatchObject({ status: null, transport_fee: null, doc_received: false, shop_name: "Shop 4" });
    });
  });
});
