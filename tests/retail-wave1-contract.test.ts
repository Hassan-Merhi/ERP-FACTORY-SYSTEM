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

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

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

  it("routes retail companies into the retail workspace", () => {
    const guard = read("client/src/app/authenticatedAppRouteGuard.ts");
    expect(guard).toContain('const isRetailCompany = companyType === "retail"');
    expect(guard).toContain('currentLocation === "/retail" || currentLocation.startsWith("/retail/")');
    expect(guard).toContain('decision = { kind: "redirect", to: "/retail" }');
  });

  it("rejects the retail workspace for non-retail companies", () => {
    const guard = read("client/src/app/authenticatedAppRouteGuard.ts");
    expect(guard).toContain("isRetailRoute && !isRetailCompany");
    expect(guard).toContain('decision = { kind: "redirect", to: "/tracking" }');
  });
});

describe("retail product and import contracts", () => {
  it("accepts multiple independently barcoded size variants with location stock", () => {
    const result = retailProductWriteSchema.parse({
      code: "TSHIRT-01",
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

  it("requires the import foundation columns and defaults empty brand to no-brand", () => {
    const row = retailImportRowSchema.parse({
      code: "SHOE-1",
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
});
