/**
 * Manual ERP PO Import export for a posted truck trip
 * (loadingDispatchPoExportRoutes.ts) through the real HTTP app, one
 * rolled-back transaction per test. Pins the role and id guards, the request
 * validation, the posted-source and preview fingerprint guards, the real
 * workbook download with its single recorded export, the idempotent replay and
 * the refusal of a different file once one was generated.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { createTrip, dispatchBase, loadingWithBales, postedTrip } from "./helpers/dispatchFlowFixture";

const charges = { freight: "10.00", surcharge: "0.00", fumigation: "0.00", discount: "0.00", documentCharges: "0.00" };
const choice = (supplierCode = "SUP-1") => ({ supplierCode, rates: [{ articleCode: "ART-A", rate: "3.50" }], charges });

const exportsOf = (w: FactoryWorld, dispatchId: number) =>
  w.q<{ id: number; supplier_code: string }>(
    `SELECT id, supplier_code FROM factory_dispatch_trip_exports WHERE company_id = $1 AND dispatch_id = $2`,
    [w.companyId, dispatchId]
  );

async function posted(w: FactoryWorld) {
  const { orderId, bales } = await loadingWithBales(w, ["100.00", "50.00"]);
  const { dispatchId } = await postedTrip(
    w,
    orderId,
    bales.map((b) => b.reference)
  );
  const base = `${dispatchBase(orderId)}/${dispatchId}/po-export`;
  const setup = await w.agent.get(`${base}/setup`);
  expect(setup.status).toBe(200);
  return { orderId, dispatchId, base, setup: setup.body };
}

function binary(res: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (e: Error | null, b: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c) => chunks.push(c!));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

describe("trip PO export guards", () => {
  it("allows only supervisors, validates ids and requires a closed, posted trip", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId } = await loadingWithBales(w, ["100.00"]);
      const open = await createTrip(w, orderId);
      const notClosed = await w.agent.get(`${dispatchBase(orderId)}/${open}/po-export/setup`);
      expect(notClosed.status).toBe(409);
      expect(notClosed.body.code).toBe("PO_TRIP_NOT_CLOSED");
      const badId = await w.agent.get(`${dispatchBase(orderId)}/abc/po-export/setup`);
      expect(badId.body.code).toBe("PO_ID_INVALID");
      const noOrder = await w.agent.get(`${dispatchBase(999999999)}/${open}/po-export/setup`);
      expect(noOrder.body.code).toBe("PO_ORDER_UNAVAILABLE");
      await w.setRole("Manager");
      const manager = await w.agent.get(`${dispatchBase(orderId)}/${open}/po-export/setup`);
      expect(manager.status).toBe(403);
      expect(manager.body.code).toBe("TRIP_PO_EXPORT_ROLE_REQUIRED");
    });
  });

  it("shows the setup, previews rates and refuses malformed or stale previews", async () => {
    await withFactoryWorld(async (w) => {
      const { base, setup } = await posted(w);
      expect(setup).toMatchObject({ status: "POSTED", previousExport: null });
      expect(setup.articles).toEqual([expect.objectContaining({ articleCode: "ART-A", quantity: 2 })]);
      const fingerprint = { expectedSourceFingerprint: setup.sourceFingerprint, expectedRevision: setup.revision };

      const asArray = await w.agent.post(`${base}/preview`).send([1]);
      expect(asArray.body.code).toBe("PO_REQUEST_INVALID");
      expect((await w.agent.post(`${base}/preview`).send({ ...fingerprint })).body.code).toBe("PO_CHOICE_INVALID");
      const arrCharges = await w.agent
        .post(`${base}/preview`)
        .send({ ...fingerprint, choice: { supplierCode: "S", rates: [], charges: [] } });
      expect(arrCharges.body.code).toBe("PO_CHOICE_INVALID");
      const stale = await w.agent
        .post(`${base}/preview`)
        .send({ expectedSourceFingerprint: "0".repeat(64), expectedRevision: setup.revision, choice: choice() });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("TRIP_PO_SOURCE_CHANGED");

      const preview = await w.agent.post(`${base}/preview`).send({ ...fingerprint, choice: choice() });
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        supplierCode: "SUP-1",
        goodsTotal: "7.00",
        chargesTotal: "10.00",
        supplierInvoiceTotal: "17.00",
        alreadyGenerated: false,
        rowCount: 1,
      });
    });
  });
});

describe("trip PO export download", () => {
  it("refuses unreviewed, unpreviewed and changed downloads without recording an export", async () => {
    await withFactoryWorld(async (w) => {
      const { dispatchId, base, setup } = await posted(w);
      const download = (body: object) => w.agent.post(`${base}/download`).send(body);
      const reviewed = { confirmRatesReviewed: true, confirmChargesReviewed: true };
      expect((await download({ confirmRatesReviewed: true })).body.code).toBe("PO_OPERATOR_REVIEW_REQUIRED");
      expect((await download({ ...reviewed, expectedSourceFingerprint: "x" })).body.code).toBe("PO_PREVIEW_REQUIRED");
      const stale = await download({
        ...reviewed,
        expectedSourceFingerprint: "a".repeat(64),
        expectedExportFingerprint: "b".repeat(64),
        expectedRevision: setup.revision,
        choice: choice(),
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("TRIP_PO_SOURCE_CHANGED");
      const changed = await download({
        ...reviewed,
        expectedSourceFingerprint: setup.sourceFingerprint,
        expectedExportFingerprint: "b".repeat(64),
        expectedRevision: setup.revision,
        choice: choice(),
      });
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe("PO_PREVIEW_CHANGED");
      expect(await exportsOf(w, dispatchId)).toEqual([]);
    });
  });

  it("downloads a real workbook once, replays it, and refuses different content afterwards", async () => {
    await withFactoryWorld(async (w) => {
      const { dispatchId, base, setup } = await posted(w);
      const fingerprint = { expectedSourceFingerprint: setup.sourceFingerprint, expectedRevision: setup.revision };
      const preview = await w.agent.post(`${base}/preview`).send({ ...fingerprint, choice: choice() });
      const body = {
        ...fingerprint,
        confirmRatesReviewed: true,
        confirmChargesReviewed: true,
        expectedExportFingerprint: preview.body.exportFingerprint,
        choice: choice(),
      };
      const first = await w.agent.post(`${base}/download`).send(body).buffer(true).parse(binary);
      expect(first.status).toBe(200);
      expect(first.headers["x-factory-export-replay"]).toBe("false");
      expect(first.headers["content-disposition"]).toContain(".xlsx");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(first.body as unknown as ExcelJS.Buffer);
      const sheet = workbook.worksheets[0];
      const header = (sheet.getRow(1).values as unknown[]).slice(1);
      expect(header).toEqual(
        expect.arrayContaining(["PO_Number", "Supplier_Code", "Item_Barcode", "Quantity", "Rate"])
      );
      const rowValues = (sheet.getRow(2).values as unknown[]).slice(1);
      expect(rowValues).toEqual(expect.arrayContaining(["SUP-1", "ART-A", 2, 3.5]));
      expect(await exportsOf(w, dispatchId)).toEqual([expect.objectContaining({ supplier_code: "SUP-1" })]);

      const replay = await w.agent.post(`${base}/download`).send(body).buffer(true).parse(binary);
      expect(replay.status).toBe(200);
      expect(replay.headers["x-factory-export-replay"]).toBe("true");
      expect(await exportsOf(w, dispatchId)).toHaveLength(1);

      const again = await w.agent.post(`${base}/preview`).send({ ...fingerprint, choice: choice() });
      expect(again.body.alreadyGenerated).toBe(true);
      const different = await w.agent.post(`${base}/preview`).send({ ...fingerprint, choice: choice("SUP-2") });
      expect(different.status).toBe(409);
      expect(different.body.code).toBe("TRIP_PO_ALREADY_EXPORTED_DIFFERENT_CONTENT");
      const setupAfter = await w.agent.get(`${base}/setup`);
      expect(setupAfter.body.previousExport).toMatchObject({ supplierCode: "SUP-1" });
    });
  });
});
