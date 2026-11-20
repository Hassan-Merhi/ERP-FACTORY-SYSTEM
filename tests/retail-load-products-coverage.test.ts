/**
 * Retail product loader helpers: brand resolution, location and barcode
 * guards, the product/variant/stock aggregation in loadProducts, and every
 * filter in filterProducts. The database helpers run against a company that
 * lives only inside one rolled-back transaction.
 */
import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult } from "pg";
import type { Request } from "express";

import { db } from "../server/db";
import {
  asNumber,
  assertUniqueBarcodes,
  filterProducts,
  loadProducts,
  normalize,
  resolveBrand,
  validateLocations,
} from "../server/routes/retailRoutesLoadProducts";
import type { RetailProductWrite } from "@shared/schema";
import { withRolledBackPool } from "./helpers/routedPoolClient";

let seq = 0;
const idOf = async (result: Promise<QueryResult>) => Number((await result).rows[0].id);

async function company(client: PoolClient) {
  const tag = `RLP${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase().slice(0, 18);
  const companyId = await idOf(
    client.query(
      `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'retail', 'USD') RETURNING id`,
      [tag]
    )
  );
  const shop = await idOf(
    client.query(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`, [
      companyId,
      `${tag}S`,
    ])
  );
  const store = await idOf(
    client.query(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Store') RETURNING id`, [
      companyId,
      `${tag}T`,
    ])
  );
  return { companyId, shop, store, tag };
}

function write(input: Partial<RetailProductWrite>): RetailProductWrite {
  return { variants: [], ...input } as unknown as RetailProductWrite;
}

describe("retail brand, location and barcode guards", () => {
  it("resolves a brand by id only inside the company, else by name", async () => {
    await withRolledBackPool(async (client) => {
      const a = await company(client);
      const b = await company(client);
      const brandId = await idOf(
        client.query(
          `INSERT INTO retail_brands (company_id, name, normalized_name) VALUES ($1, 'Acme', 'acme') RETURNING id`,
          [a.companyId]
        )
      );
      expect((await resolveBrand(db, a.companyId, write({ brandId }))).name).toBe("Acme");
      await expect(resolveBrand(db, b.companyId, write({ brandId }))).rejects.toThrow(
        "Brand not found for this company"
      );
      const created = await resolveBrand(db, b.companyId, write({ brandName: "  Fresh  " }));
      expect(created).toMatchObject({ companyId: b.companyId, name: "Fresh" });
      const again = await resolveBrand(db, b.companyId, write({ brandName: "fresh" }));
      expect(again.id).toBe(created.id);
    });
  });

  it("accepts own locations, skips empty input and refuses another company's location", async () => {
    await withRolledBackPool(async (client) => {
      const a = await company(client);
      const b = await company(client);
      await expect(validateLocations(db, a.companyId, write({ variants: [] }))).resolves.toBeUndefined();
      const own = write({
        variants: [{ stocks: [{ locationId: a.shop }, { locationId: a.store }] }, { stocks: [{ locationId: a.shop }] }],
      } as never);
      await expect(validateLocations(db, a.companyId, own)).resolves.toBeUndefined();
      const foreign = write({ variants: [{ stocks: [{ locationId: a.shop }, { locationId: b.shop }] }] } as never);
      await expect(validateLocations(db, a.companyId, foreign)).rejects.toThrow(
        `Location ${b.shop} does not belong to the selected company`
      );
    });
  });

  it("refuses a barcode another variant owns but allows the variant to keep its own", async () => {
    await withRolledBackPool(async (client) => {
      const a = await company(client);
      const productId = await idOf(
        client.query(`INSERT INTO retail_products (company_id, code, name) VALUES ($1, 'P1', 'Shirt') RETURNING id`, [
          a.companyId,
        ])
      );
      const variantId = await idOf(
        client.query(
          `INSERT INTO retail_product_variants (company_id, product_id, size, barcode) VALUES ($1, $2, 'M', 'BC-1') RETURNING id`,
          [a.companyId, productId]
        )
      );
      await expect(assertUniqueBarcodes(db, a.companyId, [{ barcode: "  " }] as never)).resolves.toBeUndefined();
      await expect(
        assertUniqueBarcodes(db, a.companyId, [{ id: variantId, barcode: " BC-1 " }] as never)
      ).resolves.toBeUndefined();
      await expect(assertUniqueBarcodes(db, a.companyId, [{ barcode: "BC-1" }] as never)).rejects.toThrow(
        "Barcode already exists: BC-1"
      );
      await expect(
        assertUniqueBarcodes(db, a.companyId, [{ id: variantId + 999, barcode: "BC-1" }] as never)
      ).rejects.toThrow("Barcode already exists: BC-1");
      const other = await company(client);
      await expect(assertUniqueBarcodes(db, other.companyId, [{ barcode: "BC-1" }] as never)).resolves.toBeUndefined();
    });
  });
});

describe("loadProducts", () => {
  it("aggregates variants and stocks, ignores inactive variants in the summary and scopes by company", async () => {
    await withRolledBackPool(async (client) => {
      const a = await company(client);
      const brandId = await idOf(
        client.query(
          `INSERT INTO retail_brands (company_id, name, normalized_name) VALUES ($1, 'Acme', 'acme') RETURNING id`,
          [a.companyId]
        )
      );
      const shirt = await idOf(
        client.query(
          `INSERT INTO retail_products (company_id, code, name, brand_id, category, image_urls)
         VALUES ($1, 'SH', 'Shirt', $2, 'Tops', '["https://img/a.png"]'::jsonb) RETURNING id`,
          [a.companyId, brandId]
        )
      );
      const bare = await idOf(
        client.query(`INSERT INTO retail_products (company_id, code, name) VALUES ($1, 'BR', 'Bare') RETURNING id`, [
          a.companyId,
        ])
      );
      const red = await idOf(
        client.query(
          `INSERT INTO retail_product_variants (company_id, product_id, color, size, barcode, selling_price, image_urls, low_stock_threshold)
         VALUES ($1, $2, 'Red', 'M', 'R-M', '12', '["https://img/r.png", 5]'::jsonb, '2') RETURNING id`,
          [a.companyId, shirt]
        )
      );
      await idOf(
        client.query(
          `INSERT INTO retail_product_variants (company_id, product_id, color, size, barcode, selling_price)
         VALUES ($1, $2, 'Blue', 'L', 'B-L', '20') RETURNING id`,
          [a.companyId, shirt]
        )
      );
      await idOf(
        client.query(
          `INSERT INTO retail_product_variants (company_id, product_id, color, size, barcode, selling_price, active)
         VALUES ($1, $2, 'Gold', 'S', 'G-S', '99', FALSE) RETURNING id`,
          [a.companyId, shirt]
        )
      );
      await client.query(
        `INSERT INTO retail_variant_inventory (company_id, variant_id, location_id, quantity) VALUES ($1, $2, $3, '3'), ($1, $2, $4, '4')`,
        [a.companyId, red, a.shop, a.store]
      );

      const all = await loadProducts(a.companyId);
      expect(all.map((product) => product.name)).toEqual(["Bare", "Shirt"]);
      const bareProduct = all[0];
      expect(bareProduct).toMatchObject({
        id: bare,
        brand: { id: null },
        variants: [],
        totalQuantity: 0,
        minSellingPrice: 0,
        maxSellingPrice: 0,
        imageUrls: [],
      });
      const shirtProduct = all[1];
      expect(shirtProduct).toMatchObject({
        brand: { id: brandId, name: "Acme" },
        imageUrls: ["https://img/a.png"],
        availableColors: ["Blue", "Red"],
        availableSizes: ["L", "M"],
        totalQuantity: 7,
        minSellingPrice: 12,
        maxSellingPrice: 20,
      });
      const redVariant = shirtProduct.variants.find((variant) => variant.id === red)!;
      expect(redVariant).toMatchObject({ quantity: 7, imageUrls: ["https://img/r.png"], lowStockThreshold: 2 });
      expect(redVariant.stocks.map((stock) => [stock.locationName, stock.quantity])).toEqual([
        ["Shop", 3],
        ["Store", 4],
      ]);

      expect((await loadProducts(a.companyId, shirt)).map((product) => product.id)).toEqual([shirt]);
      const b = await company(client);
      expect(await loadProducts(b.companyId, shirt)).toEqual([]);
    });
  });
});

type Product = Awaited<ReturnType<typeof loadProducts>>[number];

function product(overrides: Partial<Product> & { variants: Product["variants"] }): Product {
  const active = overrides.variants.filter((variant) => variant.active);
  return {
    id: 1,
    code: "P",
    name: "Product",
    category: null,
    description: null,
    imageUrls: [],
    active: true,
    brand: { id: null, name: "No Brand" },
    availableColors: [],
    availableSizes: [],
    totalQuantity: active.reduce((sum, variant) => sum + variant.quantity, 0),
    minSellingPrice: 0,
    maxSellingPrice: 0,
    ...overrides,
  };
}

function variant(overrides: Partial<Product["variants"][number]>): Product["variants"][number] {
  return {
    id: 1,
    color: "Red",
    size: "M",
    imageUrls: [],
    barcode: "",
    barcodeSource: "manual",
    sku: null,
    cost: 0,
    sellingPrice: 0,
    lowStockThreshold: 0,
    active: true,
    quantity: 0,
    stocks: [],
    ...overrides,
  };
}

describe("filterProducts", () => {
  const shirt = product({
    id: 1,
    code: "SH",
    name: "Shirt",
    category: "Tops",
    brand: { id: 7, name: "Acme" },
    variants: [
      variant({
        color: "Red",
        size: "M",
        barcode: "R-M",
        sku: "SKU-1",
        quantity: 2,
        lowStockThreshold: 5,
        stocks: [{ locationId: 3, locationName: "Shop", quantity: 2 }],
      }),
    ],
  });
  const pants = product({
    id: 2,
    code: "PA",
    name: "Pants",
    category: null,
    variants: [variant({ color: "Blue", size: "L", quantity: 10, lowStockThreshold: 2 })],
  });
  const empty = product({ id: 3, code: "EM", name: "Empty", variants: [variant({ color: "Green", size: "S" })] });
  const all = [shirt, pants, empty];
  const ids = (query: Record<string, unknown>) => filterProducts(all, query as Request["query"]).map((item) => item.id);

  it("returns everything without filters", () => {
    expect(ids({})).toEqual([1, 2, 3]);
  });

  it("searches code, name, brand, colour, size, barcode and sku", () => {
    expect(ids({ search: "  ACME " })).toEqual([1]);
    expect(ids({ search: "sku-1" })).toEqual([1]);
    expect(ids({ search: "blue l" })).toEqual([2]);
    expect(ids({ search: "missing" })).toEqual([]);
  });

  it("filters by brand, category, colour, size and location", () => {
    expect(ids({ brandId: "7" })).toEqual([1]);
    expect(ids({ category: "tops" })).toEqual([1]);
    expect(ids({ color: "GREEN" })).toEqual([3]);
    expect(ids({ size: "l" })).toEqual([2]);
    expect(ids({ locationId: "3" })).toEqual([1]);
    expect(ids({ locationId: "99" })).toEqual([]);
  });

  it("filters by stock status", () => {
    expect(ids({ stockStatus: "out" })).toEqual([3]);
    expect(ids({ stockStatus: "low" })).toEqual([1]);
    expect(ids({ stockStatus: "in" })).toEqual([1, 2]);
    expect(ids({ stockStatus: "all" })).toEqual([1, 2, 3]);
  });

  it("normalises whitespace and coerces numbers", () => {
    expect(normalize("  A   b\tC ")).toBe("a b c");
    expect(asNumber(null)).toBe(0);
    expect(asNumber("2.5")).toBe(2.5);
  });
});
