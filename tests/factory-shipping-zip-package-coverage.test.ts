/**
 * GET /api/factory/shipping-container-rows/:id/zip-package
 * (server/routes/factory/shipping-containers/zip-package.ts) against real rows
 * in one rolled-back transaction per test.
 *
 * Only the self-HTTP export fetch (fetchInternalBuffer, which calls this
 * server's own Excel/PDF endpoints over a socket) is mocked; the company scope,
 * row lookup, uploaded-document resolution and ZIP assembly are real.
 */
import type request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchInternalBuffer = vi.hoisted(() => vi.fn());
vi.mock("../server/routes/factory/shipping-containers/_helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/routes/factory/shipping-containers/_helpers")>()),
  fetchInternalBuffer,
}));

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const zipUrl = (id: number | string, fileIds: string) =>
  `/api/factory/shipping-container-rows/${id}/zip-package?fileIds=${encodeURIComponent(fileIds)}`;

async function shippingRow(w: FactoryWorld) {
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Zip Client') RETURNING id`,
    [w.companyId, `${w.tag}Z`]
  );
  const orderId = await w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id, container_number, destination)
     VALUES ($1, $2, '2026-06-01', 'FINALIZED', $3, 'MSCU1234567', 'Lusaka') RETURNING id`,
    [w.companyId, customerId, w.locationId]
  );
  const rowId = await w.one(
    `INSERT INTO factory_shipping_container_rows (company_id, customer_order_id, order_date) VALUES ($1, $2, '2026-06-01') RETURNING id`,
    [w.companyId, orderId]
  );
  return { rowId, orderId, customerId };
}

const doc = (
  w: FactoryWorld,
  rowId: number,
  fields: { original: string; display?: string; file?: string; data?: string | null }
) =>
  w.one(
    `INSERT INTO factory_shipping_container_documents (company_id, scr_id, display_name, file_name, file_url, original_name, file_data)
     VALUES ($1, $2, $3, $4, '/x', $5, $6) RETURNING id`,
    [w.companyId, rowId, fields.display ?? "", fields.file ?? "", fields.original, fields.data ?? null]
  );

/** Collect a binary response body (ZIP/PDF/XLSX) as a Buffer. */
function binary(test: request.Test): request.Test {
  return test.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => callback(null, Buffer.concat(chunks)));
  });
}

beforeEach(() => {
  fetchInternalBuffer.mockReset();
});

describe("shipping ZIP package refusals", () => {
  it("rejects a bad id, an empty selection and another company's row", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.get(zipUrl("abc", "invoice_excel"))).status).toBe(400);
      const empty = await w.agent.get(
        `/api/factory/shipping-container-rows/1/zip-package?fileIds=${encodeURIComponent(" , ")}`
      );
      expect(empty.status).toBe(400);
      expect(empty.body.message).toBe("No files selected");
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreignCustomer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Other Client') RETURNING id`,
        [other, `${w.tag}OC`]
      );
      const foreignOrder = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, '2026-06-01', 'FINALIZED') RETURNING id`,
        [other, foreignCustomer]
      );
      const foreignRow = await w.one(
        `INSERT INTO factory_shipping_container_rows (company_id, customer_order_id, order_date) VALUES ($1, $2, '2026-06-01') RETURNING id`,
        [other, foreignOrder]
      );
      const res = await w.agent.get(zipUrl(foreignRow, "invoice_excel"));
      expect(res.status).toBe(404);
      expect(fetchInternalBuffer).not.toHaveBeenCalled();
    });
  });

  it("names every missing or empty selected file with 409", async () => {
    await withFactoryWorld(async (w) => {
      const { rowId } = await shippingRow(w);
      const emptyDoc = await doc(w, rowId, { original: "", display: " ", file: "", data: "" });
      const missingDisk = await doc(w, rowId, { original: "lost.pdf", file: "no-such-file.pdf" });
      fetchInternalBuffer.mockResolvedValueOnce(Buffer.alloc(0)).mockResolvedValueOnce(null);
      const res = await w.agent.get(
        zipUrl(rowId, `invoice_excel,statement_pdf,doc_${emptyDoc},doc_${missingDisk},doc_999999999,doc_x`)
      );
      expect(res.status).toBe(409);
      expect(res.body.message).toContain("Commercial Invoice");
      expect(res.body.message).toContain("Customer Statement");
      expect(res.body.message).toContain(`document_${emptyDoc}`);
      expect(res.body.message).toContain("lost.pdf");
      expect(res.body.message).toContain("Uploaded document 999999999");
    });
  });

  it("refuses a selection that resolves to no files", async () => {
    await withFactoryWorld(async (w) => {
      const { rowId } = await shippingRow(w);
      const none = await w.agent.get(zipUrl(rowId, "unknown_kind"));
      expect(none.status).toBe(409);
      expect(none.body.message).toBe("No selected files contained downloadable data.");
      expect(fetchInternalBuffer).not.toHaveBeenCalled();
    });
  });

  it("returns 500 when an internal export fetch fails", async () => {
    await withFactoryWorld(async (w) => {
      const { rowId } = await shippingRow(w);
      fetchInternalBuffer.mockRejectedValueOnce(new Error("export socket closed"));
      const res = await w.agent.get(zipUrl(rowId, "invoice_excel"));
      expect(res.status).toBe(500);
      expect(res.body.message).toBe("export socket closed");
    });
  });
});

describe("shipping ZIP package success", () => {
  it("bundles the invoice, statement and uploaded documents into one ZIP", async () => {
    await withFactoryWorld(async (w) => {
      const { rowId, orderId, customerId } = await shippingRow(w);
      const stored = await doc(w, rowId, {
        original: "folder/Bill of Lading.pdf",
        data: Buffer.from("bill-of-lading").toString("base64"),
      });
      // Older rows without stored data fall back to the disk cache by file name.
      const cached = await doc(w, rowId, { original: "", display: "Packing list", file: "../../package.json" });
      fetchInternalBuffer
        .mockResolvedValueOnce(Buffer.from("xlsx-bytes"))
        .mockResolvedValueOnce(Buffer.from("pdf-bytes"));

      const res = await binary(w.agent.get(zipUrl(rowId, `invoice_excel,statement_pdf,doc_${stored},doc_${cached}`)));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/zip");
      expect(res.headers["content-disposition"]).toBe('attachment; filename="MSCU1234567_Zip_Client_Lusaka.zip"');
      const body = res.body as Buffer;
      expect(body.subarray(0, 2).toString()).toBe("PK");
      const text = body.toString("latin1");
      for (const name of ["MSCU1234567_Zip_Client_Lusaka.xlsx", "Bill of Lading.pdf", "Packing list"]) {
        expect(text).toContain(name);
      }
      expect(fetchInternalBuffer.mock.calls.map((call) => call[1])).toEqual([
        `/api/factory/customer-orders/${orderId}/export-excel`,
        `/api/factory/customers/${customerId}/statement/export-pdf`,
      ]);
    });
  });
});
