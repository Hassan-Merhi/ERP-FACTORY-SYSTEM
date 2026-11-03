/**
 * Retail supplier purchase receipts against PostgreSQL: catalog rows,
 * inventory, the supplier payable journal and the durable request key are
 * written in one transaction. Each case runs inside a rolled-back transaction
 * that every pool and drizzle call is routed to.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { db } from "../server/db";
import { companyBusinessDate } from "../server/services/accounting/companyBusinessDate";
import { postRetailSupplierPurchase } from "../server/services/retail/retailSupplierPurchaseService";
import { withRolledBackPool } from "./helpers/routedPoolClient";

let seq = 0;

async function id(client: PoolClient, text: string, values: unknown[]): Promise<number> {
  return Number((await client.query<{ id: number }>(text, values)).rows[0].id);
}

type World = Awaited<ReturnType<typeof seed>>;

async function seed(client: PoolClient, options: { opening?: string | null } = {}) {
  const tag = `RSP${process.pid}${++seq}`;
  const companyId = await id(
    client,
    "INSERT INTO companies(code,name,company_type) VALUES($1,$2,'retail') RETURNING id",
    [tag, tag]
  );
  const location = (active = true) =>
    id(client, "INSERT INTO locations(company_id,code,name,active) VALUES($1,$2,'Shop',$3) RETURNING id", [
      companyId,
      `${tag}-L${++seq}`,
      active,
    ]);
  const supplier = (extra: { active?: boolean; deleted?: boolean; companyId?: number } = {}) =>
    id(
      client,
      "INSERT INTO suppliers(company_id,code,legal_name,email,active,deleted_at) VALUES($1,$2,'Vendor','v@x.test',$3,$4) RETURNING id",
      [extra.companyId ?? companyId, `${tag}-S${++seq}`, extra.active ?? true, extra.deleted ? new Date() : null]
    );
  const locationId = await location();
  const supplierId = await supplier();
  const userId = (
    await client.query<{ id: string }>("INSERT INTO users(username,password) VALUES($1,'x') RETURNING id", [
      `${tag}-buyer`,
    ])
  ).rows[0].id;
  const today = await companyBusinessDate(companyId, db);
  const opening = options.opening === undefined ? "2026-01-01" : options.opening;
  if (opening) {
    await client.query(
      `INSERT INTO retail_inventory_openings(company_id,opening_date,sub_ledger_value,ledger_balance_before,amount,plan_hash,applied_by)
       VALUES($1,$2,0,0,0,'hash','1')`,
      [companyId, opening]
    );
  }
  const file = (type: string, base64: string, size = 100, owner = companyId) =>
    id(
      client,
      "INSERT INTO stored_files(company_id,file_name,file_type,file_size,file_data) VALUES($1,'f',$2,$3,$4) RETURNING id",
      [owner, type, size, base64]
    );
  return {
    client,
    companyId,
    locationId,
    supplierId,
    location,
    supplier,
    file,
    today,
    tag,
    actor: { userId, username: "buyer" },
  };
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]).toString("base64");
const PDF = Buffer.from("%PDF-1.7 test").toString("base64");
const GIF = Buffer.from("GIF89a....").toString("base64");

const line = (over: Record<string, unknown> = {}) => ({
  rowNumber: 2,
  name: "Sneaker",
  brand: "Stride",
  category: "Shoes",
  color: "Black",
  size: "42",
  quantity: 5,
  costPrice: 12.5,
  sellingPrice: 35,
  sku: "",
  barcode: "",
  imageUrls: [],
  ...over,
});

const purchase = (w: World, over: Record<string, unknown> = {}) =>
  postRetailSupplierPurchase(w.companyId, w.actor, {
    idempotencyKey: `${w.tag}-key-${++seq}-000000`,
    supplierId: w.supplierId,
    locationId: w.locationId,
    invoiceReference: "SUP-1",
    invoiceDate: w.today,
    lines: [line()],
    ...over,
  });

async function voucherLines(client: PoolClient, voucherId: number) {
  return (
    await client.query(
      `SELECT CASE WHEN e.supplier_id IS NOT NULL THEN 'supplier' ELSE la.code END AS target,
              e.debit_amount::numeric(20,2)::text AS debit, e.credit_amount::numeric(20,2)::text AS credit,
              e.transaction_currency AS currency, e.transaction_debit_amount::numeric(20,2)::text AS native_debit
         FROM voucher_entries e LEFT JOIN ledger_accounts la ON la.id=e.ledger_account_id
        WHERE e.voucher_id=$1 ORDER BY e.id`,
      [voucherId]
    )
  ).rows;
}

async function stock(client: PoolClient, w: World, variantId: number, locationId = w.locationId) {
  return (
    await client.query(
      `SELECT quantity::int::text AS quantity, average_cost::numeric(20,6)::text AS average_cost
         FROM retail_variant_inventory WHERE company_id=$1 AND variant_id=$2 AND location_id=$3`,
      [w.companyId, variantId, locationId]
    )
  ).rows[0];
}

describe("postRetailSupplierPurchase", () => {
  it("receives stock, posts the payable and replays the same request", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const input = {
        idempotencyKey: `${w.tag}-first-receipt`,
        supplierId: w.supplierId,
        locationId: w.locationId,
        invoiceReference: "SUP-1",
        invoiceDate: w.today,
        lines: [line(), line({ rowNumber: 3, size: "43", quantity: 2, costPrice: 10 })],
      };
      const result = await postRetailSupplierPurchase(w.companyId, w.actor, input);
      expect(result).toMatchObject({
        replayed: false,
        supplierId: w.supplierId,
        locationId: w.locationId,
        invoiceReference: "SUP-1",
        currency: "USD",
        purchaseTotal: "82.500000",
        deliveryReference: "",
        partialReceipt: false,
        invoiceFileId: null,
      });
      expect(Number(result.baseTotal)).toBe(82.5);
      expect(result.items).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          quantity: 5,
          name: "Sneaker",
          size: "42",
          unitCost: "12.5000",
          sellingPrice: "35.0000",
        }),
        expect.objectContaining({ rowNumber: 3, quantity: 2, size: "43", unitCost: "10.0000" }),
      ]);
      expect(result.items[0].barcode).toBeTruthy();
      expect(result.items[0].variantId).not.toBe(result.items[1].variantId);

      expect(await voucherLines(client, result.voucherId)).toEqual([
        expect.objectContaining({ debit: "82.50", credit: "0.00" }),
        expect.objectContaining({ target: "supplier", debit: "0.00", credit: "82.50" }),
      ]);
      const [voucher] = (
        await client.query(
          "SELECT voucher_number, voucher_type, voucher_date::text, currency FROM vouchers WHERE id=$1",
          [result.voucherId]
        )
      ).rows;
      expect(voucher).toEqual({
        voucher_number: `RETAIL-SUP-${result.operationId}`,
        voucher_type: "Journal",
        voucher_date: w.today,
        currency: "USD",
      });
      expect(await stock(client, w, result.items[0].variantId)).toEqual({ quantity: "5", average_cost: "12.500000" });

      const movements = (
        await client.query(
          "SELECT movement_type, quantity_delta::int::text AS delta, event_key FROM retail_stock_movements WHERE company_id=$1 ORDER BY id",
          [w.companyId]
        )
      ).rows;
      expect(movements).toEqual([
        { movement_type: "receive", delta: "5", event_key: `supplier-purchase:${result.operationId}:2` },
        { movement_type: "receive", delta: "2", event_key: `supplier-purchase:${result.operationId}:3` },
      ]);

      const replay = await postRetailSupplierPurchase(w.companyId, w.actor, input);
      expect(replay).toEqual({ ...result, replayed: true });

      await expect(
        postRetailSupplierPurchase(w.companyId, w.actor, { ...input, invoiceReference: "SUP-2" })
      ).rejects.toThrow("Request ID was already used for a different stock operation");
      await client.query(
        "INSERT INTO retail_stock_operations(company_id,operation_type,idempotency_key,created_by,metadata) VALUES($1,'transfer',$2,$3,'{}')",
        [w.companyId, `${w.tag}-other-operation`, w.actor.userId]
      );
      await expect(
        postRetailSupplierPurchase(w.companyId, w.actor, { ...input, idempotencyKey: `${w.tag}-other-operation` })
      ).rejects.toThrow("Request ID was already used for a different stock operation");
    });
  });

  it("restocks an existing variant at the weighted average cost", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const first = await purchase(w);
      const barcode = first.items[0].barcode;
      const second = await purchase(w, {
        invoiceReference: "SUP-2",
        lines: [line({ barcode, quantity: 15, costPrice: 20 })],
      });
      expect(second.items[0].variantId).toBe(first.items[0].variantId);
      // (5 × 12.50 + 15 × 20) / 20 = 18.125.
      expect(await stock(client, w, first.items[0].variantId)).toEqual({ quantity: "20", average_cost: "18.125000" });
    });
  });

  it("receives into oversold stock at the receipt cost", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const first = await purchase(w);
      const variantId = first.items[0].variantId;
      await client.query(
        "UPDATE retail_variant_inventory SET quantity=-3 WHERE company_id=$1 AND variant_id=$2 AND location_id=$3",
        [w.companyId, variantId, w.locationId]
      );
      const second = await purchase(w, {
        invoiceReference: "SUP-2",
        lines: [line({ barcode: first.items[0].barcode, quantity: 10, costPrice: 20 })],
      });
      expect(await stock(client, w, variantId)).toEqual({ quantity: "7", average_cost: "20.000000" });
      expect((await voucherLines(client, second.voucherId)).map((l) => [l.debit, l.credit])).toEqual([
        ["200.00", "0.00"],
        ["0.00", "200.00"],
      ]);
    });
  });

  it("values foreign-currency invoices at the stored six-decimal rate", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const result = await purchase(w, {
        currency: "eur",
        exchangeRate: "0.80000004",
        lines: [line({ quantity: 4, costPrice: 10 })],
      });
      expect(result.currency).toBe("EUR");
      expect(result.purchaseTotal).toBe("40.000000");
      // 40 EUR at 0.8 EUR per USD = 50 USD.
      expect(Number(result.baseTotal)).toBe(50);
      expect(await stock(client, w, result.items[0].variantId)).toEqual({ quantity: "4", average_cost: "12.500000" });
      const [debit, credit] = await voucherLines(client, result.voucherId);
      expect(debit).toMatchObject({ debit: "50.00", currency: "EUR", native_debit: "40.00" });
      expect(credit).toMatchObject({ target: "supplier", credit: "50.00" });
      const [voucher] = (
        await client.query("SELECT currency, exchange_rate::text FROM vouchers WHERE id=$1", [result.voucherId])
      ).rows;
      expect(voucher).toEqual({ currency: "EUR", exchange_rate: "0.800000" });

      await expect(purchase(w, { invoiceReference: "SUP-9", currency: "EUR", exchangeRate: null })).rejects.toThrow();
    });
  });

  it("refuses amounts and rates outside the ledger precision", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      await expect(purchase(w, { lines: [line({ quantity: 100000, costPrice: 1_000_000_000 })] })).rejects.toThrow(
        "Supplier purchase amount must be positive and fit the accounting ledger precision"
      );
      await expect(purchase(w, { lines: [line({ costPrice: 0 })] })).rejects.toThrow(
        "Supplier purchase amount must be positive and fit the accounting ledger precision"
      );
      await expect(purchase(w, { currency: "CDF", exchangeRate: "0.0000001" })).rejects.toThrow(
        "Supplier exchange rate is outside the supported accounting voucher precision"
      );
    });
  });

  it("only accepts an active supplier and location of this company", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const other = await seed(client);
      const supplierError = "Supplier is inactive or does not belong to this company";
      await expect(purchase(w, { supplierId: await w.supplier({ active: false }) })).rejects.toThrow(supplierError);
      await expect(purchase(w, { supplierId: await w.supplier({ deleted: true }) })).rejects.toThrow(supplierError);
      await expect(purchase(w, { supplierId: other.supplierId })).rejects.toThrow(supplierError);
      const locationError = "Receiving location is not active in this company";
      await expect(purchase(w, { locationId: await w.location(false) })).rejects.toThrow(locationError);
      await expect(purchase(w, { locationId: other.locationId })).rejects.toThrow(locationError);
    });
  });

  it("dates receipts between the inventory opening and today", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client, { opening: "2026-02-01" });
      await expect(purchase(w, { invoiceDate: "2099-01-01" })).rejects.toThrow(
        "Supplier invoice date cannot be in the future"
      );
      await expect(purchase(w, { invoiceDate: "2026-01-31" })).rejects.toThrow(
        "Supplier invoice date cannot be earlier than the Retail inventory opening date"
      );
      await expect(purchase(w, { invoiceDate: "2026-02-01" })).resolves.toMatchObject({ replayed: false });

      const unopened = await seed(client, { opening: null });
      await expect(purchase(unopened)).rejects.toThrow(
        "Apply the Retail inventory accounting opening before importing supplier purchases"
      );
    });
  });

  it("receives an invoice once unless every delivery is a distinct partial receipt", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      await purchase(w, { invoiceReference: " Inv-7 " });
      await expect(purchase(w, { invoiceReference: "INV-7" })).rejects.toThrow(
        "Supplier invoice already received; use a partial delivery reference only if prior receipts were partial"
      );
      await expect(
        purchase(w, { invoiceReference: "inv-7", partialReceipt: true, deliveryReference: "D1" })
      ).rejects.toThrow("Supplier invoice already received");

      const partial = await purchase(w, { invoiceReference: "P-1", partialReceipt: true, deliveryReference: " D1 " });
      expect(partial).toMatchObject({ partialReceipt: true, deliveryReference: "D1" });
      await expect(
        purchase(w, { invoiceReference: "p-1", partialReceipt: true, deliveryReference: "d1" })
      ).rejects.toThrow("This supplier invoice delivery reference has already been received");
      await expect(
        purchase(w, {
          invoiceReference: "P-1",
          partialReceipt: true,
          deliveryReference: "D2",
          currency: "EUR",
          exchangeRate: "0.9",
        })
      ).rejects.toThrow("All partial deliveries of the same supplier invoice must use the same currency");
      await expect(purchase(w, { invoiceReference: "P-1" })).rejects.toThrow("Supplier invoice already received");
      await expect(
        purchase(w, { invoiceReference: "P-1", partialReceipt: true, deliveryReference: "D2" })
      ).resolves.toMatchObject({ deliveryReference: "D2" });

      // The same reference from another supplier is a different invoice.
      await expect(purchase(w, { invoiceReference: "INV-7", supplierId: await w.supplier() })).resolves.toMatchObject({
        replayed: false,
      });
    });
  });

  it("requires a delivery reference exactly when receiving partially", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      await expect(purchase(w, { partialReceipt: true })).rejects.toThrow(
        "Each partial receipt requires a unique delivery reference"
      );
      await expect(purchase(w, { deliveryReference: "D1" })).rejects.toThrow(
        "Delivery reference is only used for partial supplier receipts"
      );
    });
  });

  it("accepts only company-owned, well-formed pictures and invoice files", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const other = await seed(client);
      const png = await w.file("image/png", PNG);
      const pdf = await w.file("application/pdf", PDF);
      const result = await purchase(w, {
        invoiceFileId: pdf,
        lines: [line({ imageUrls: [`/api/retail/media/${png}`, `/api/retail/media/${png}`] })],
      });
      expect(result.invoiceFileId).toBe(pdf);

      const pictureError = "Supplier picture is missing, unsafe, or does not belong to this company";
      for (const fileId of [
        await other.file("image/png", PNG),
        await w.file("application/pdf", PDF),
        await w.file("image/png", PDF),
        await w.file("image/png", PNG, 0),
        await w.file("image/png", PNG, 10 * 1024 * 1024 + 1),
        999999999,
        0,
      ]) {
        await expect(
          purchase(w, {
            invoiceReference: `IMG-${fileId}`,
            lines: [line({ imageUrls: [`/api/retail/media/${fileId}`] })],
          })
        ).rejects.toThrow(pictureError);
      }

      const invoiceError = "Invoice attachment must be a company-owned PDF, JPG or PNG with valid content, up to 10 MB";
      for (const fileId of [
        await w.file("image/gif", GIF),
        await w.file("application/pdf", PNG),
        await w.file("application/pdf", PDF, 0),
        await w.file("application/pdf", PDF, 10 * 1024 * 1024 + 1),
        await other.file("application/pdf", PDF),
        999999999,
      ]) {
        await expect(purchase(w, { invoiceReference: `FILE-${fileId}`, invoiceFileId: fileId })).rejects.toThrow(
          invoiceError
        );
      }
    });
  });
});
