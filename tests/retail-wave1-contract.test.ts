import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  insertCompanySchema,
  retailImportRowSchema,
  retailProductWriteSchema,
  RETAIL_NO_BRAND_NAME,
} from "../shared/schema";
import { companyTypeSchema } from "../client/src/contracts/sessionContracts";
import { resolveAuthenticatedAppRoute } from "../client/src/app/authenticatedAppRouteGuard";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const route = (currentLocation: string, companyType: string | null = "retail") =>
  resolveAuthenticatedAppRoute({
    currentLocation,
    companyType,
    isAdminOwner: true,
    myAccess: undefined,
    myAccessLoading: false,
    myAccessError: false,
    factorySettings: undefined,
  }).decision;

describe("retail company type", () => {
  it("is accepted by shared company validation and the client session contract", () => {
    expect(
      insertCompanySchema.parse({
        code: "SHOP",
        name: "Retail Shop",
        companyType: "retail",
        parentCompanyId: null,
      }).companyType
    ).toBe("retail");
    expect(companyTypeSchema.parse("retail")).toBe("retail");
  });

  it("keeps retail companies inside the normal ERP workspace", () => {
    expect(route("/")).toEqual({ kind: "redirect", to: "/financial-overview" });
    expect(route("/retail/dashboard")).toEqual({ kind: "redirect", to: "/financial-overview" });

    for (const normalErpPage of ["/financial-overview", "/accounts", "/vouchers", "/daybook", "/parties", "/create"])
      expect(route(normalErpPage)).toEqual({ kind: "continue" });
  });

  it("specializes only retail inventory and POS routes", () => {
    expect(route("/inventory")).toEqual({ kind: "redirect", to: "/retail/inventory" });
    expect(route("/stock")).toEqual({ kind: "redirect", to: "/retail/inventory" });
    expect(route("/location-inventory")).toEqual({ kind: "redirect", to: "/retail/inventory" });
    expect(route("/pos")).toEqual({ kind: "redirect", to: "/retail/pos" });
    expect(route("/retail/inventory")).toEqual({ kind: "continue" });
    expect(route("/retail/pos")).toEqual({ kind: "continue" });
  });

  it("rejects the retail workspace for non-retail companies", () => {
    expect(route("/retail/inventory", "normal")).toEqual({ kind: "redirect", to: "/tracking" });
  });
});

describe("retail product and import contracts", () => {
  it("accepts multiple independently barcoded size variants with location stock", () => {
    const result = retailProductWriteSchema.parse({
      // Product code remains an internal persistence key; the retail UI generates it automatically.
      code: "RTL-CLASSIC-TEE",
      name: "Classic Tee",
      brandName: RETAIL_NO_BRAND_NAME,
      imageUrls: ["https://example.com/tee.jpg"],
      variants: [
        {
          size: "M",
          barcode: "10000001",
          cost: 4.25,
          sellingPrice: 10,
          stocks: [{ locationId: 1, quantity: 5 }],
        },
        {
          size: "L",
          barcode: "10000002",
          cost: 4.25,
          sellingPrice: 10,
          stocks: [{ locationId: 1, quantity: 7 }],
        },
      ],
    });
    expect(result.variants).toHaveLength(2);
    expect(result.variants[0].barcode).not.toBe(result.variants[1].barcode);
    expect(result.variants[1].stocks[0].quantity).toBe(7);
  });

  it("keeps import persistence compatible while the UI generates hidden product codes", () => {
    const row = retailImportRowSchema.parse({
      code: "RTL-RUNNER",
      name: "Runner",
      size: "42",
      barcode: "600000000001",
      cost: 25,
      price: 50,
      qty: 3,
      location: "MAIN",
    });
    expect(row.brand).toBe(RETAIL_NO_BRAND_NAME);
    expect(row.qty).toBe(3);
  });

  it("rejects a variant without a barcode", () => {
    const parsed = retailProductWriteSchema.safeParse({
      code: "BAD-1",
      name: "Bad Product",
      variants: [{ size: "M", cost: 1, sellingPrice: 2, stocks: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps SKU/item code and description out of the product form and uses real image uploads", () => {
    // The product form moved into RetailProductEditor.tsx when RetailInventory.tsx was
    // split to stay under the 900-line repository limit. The negative assertions run
    // against both halves so the contract holds wherever the form ends up living.
    const editor = read("client/src/pages/retail/RetailProductEditor.tsx");
    const inventory = read("client/src/pages/retail/RetailInventory.tsx");
    const productForm = `${editor}\n${inventory}`;
    expect(productForm).not.toContain("SKU / Item code");
    expect(productForm).not.toContain("Product image URLs");
    expect(productForm).not.toContain("<Label>Description</Label>");
    expect(editor).toContain("Add brand");
    expect(editor).toContain('type="file"');
    expect(editor).toContain('accept="image/jpeg,image/png,image/webp,image/gif"');
    expect(editor).toContain('fetch("/api/files/upload"');
    expect(editor).toContain("buildInternalProductCode");
  });
});
