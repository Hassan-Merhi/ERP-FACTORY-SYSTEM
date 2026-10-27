/**
 * The factory bilingual surface resolver against PostgreSQL: which nested
 * records it localizes, how stored snapshots outrank the catalogue, how the
 * catalogue is found by product id or article code, and which legacy display
 * fields it rewrites. Catalogue rows live in a rolled-back transaction.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { resolveFactoryBilingualSurfacePayload } from "../server/services/factoryBilingualSurfaceResolver";
import { withRolledBackPool } from "./helpers/routedPoolClient";

let seq = 0;
async function catalog(client: PoolClient) {
  const tag = `FBS${process.pid}x${++seq}`;
  const companyId = Number(
    (await client.query("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [tag, tag])).rows[0].id
  );
  const categoryId = Number(
    (
      await client.query(
        "INSERT INTO factory_categories(company_id,name,name_ar,name_fr) VALUES($1,'Shirts','قمصان','Chemises') RETURNING id",
        [companyId]
      )
    ).rows[0].id
  );
  const product = async (code: string, articleCode: string | null, over: Record<string, string | null> = {}) =>
    Number(
      (
        await client.query(
          `INSERT INTO factory_bale_products(company_id,code,name,name_ar,name_fr,description,description_ar,description_fr,article_code,category_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            companyId,
            `${tag}-${code}`,
            over.name ?? "Cotton shirt",
            over.nameAr === undefined ? "قميص قطن" : over.nameAr,
            over.nameFr === undefined ? "Chemise coton" : over.nameFr,
            "Light shirt",
            "قميص خفيف",
            null,
            articleCode,
            categoryId,
          ]
        )
      ).rows[0].id
    );
  const shirt = await product("S", "ab-100");
  const plain = await product("P", "CD-200", { name: "Plain", nameAr: null, nameFr: null });
  const deleted = await product("D", "EF-300");
  await client.query("UPDATE factory_bale_products SET deleted_at=now() WHERE id=$1", [deleted]);
  return { companyId, shirt, plain, deleted };
}

const resolve = (companyId: number, payload: unknown, language: "en" | "ar" | "fr", mutate = false) =>
  resolveFactoryBilingualSurfacePayload(companyId, payload, language, { mutateLegacyDisplayFields: mutate });

describe("resolveFactoryBilingualSurfacePayload", () => {
  it("localizes nested product rows from the catalogue by id or article code", async () => {
    await withRolledBackPool(async (client) => {
      const w = await catalog(client);
      const payload = {
        generatedAt: new Date("2026-10-20T00:00:00Z"),
        file: Buffer.from("x"),
        rows: [
          { productId: String(w.shirt), productName: null, qty: 2 },
          { product_article_code: " ab-100 ", product_name: "" },
          { baleProductId: 999999, baleName: "  " },
          { articleCode: "zz-1", name: "Unknown item" },
          { bale_product_id: w.deleted, bale_name: null },
        ],
        totals: { count: 5 },
        tags: ["a", 1, null],
      };
      const result = (await resolve(w.companyId, payload, "ar")) as typeof payload & {
        rows: Array<Record<string, unknown>>;
      };
      expect(result).toBe(payload);
      expect(result.rows[0]).toMatchObject({
        language: "ar",
        direction: "rtl",
        displayName: "قميص قطن",
        displayProductName: "قميص قطن",
        displayDescription: "قميص خفيف",
        displayCategory: "قمصان",
        displayCategoryName: "قمصان",
        normalizedArticleCode: "AB-100",
        productName: null,
      });
      expect(result.rows[1]).toMatchObject({ displayName: "قميص قطن", normalizedArticleCode: "AB-100" });
      // Not in the catalogue: the record's own text, then the article code.
      expect(result.rows[2]).toMatchObject({ language: "ar", direction: "rtl" });
      expect(result.rows[2]).not.toHaveProperty("displayName");
      expect(result.rows[3]).toMatchObject({
        displayName: "Unknown item",
        displayCategory: "ZZ-1",
        normalizedArticleCode: "ZZ-1",
      });
      expect(result.rows[4]).not.toHaveProperty("displayName");
      expect(payload.totals).toEqual({ count: 5 });
    });
  });

  it("prefers a stored snapshot in the requested language, then any snapshot", async () => {
    await withRolledBackPool(async (client) => {
      const w = await catalog(client);
      const rows = [
        { productId: w.shirt, productNameEn: "Snapshot shirt", productNameFr: "Chemise d'origine", category: "Old" },
        { productId: w.shirt, baleNameAr: "قميص قديم", categoryAr: "فئة" },
        { productId: w.plain, product_name_fr: "Uni" },
      ];
      const fr = (await resolve(w.companyId, structuredClone(rows), "fr")) as Array<Record<string, unknown>>;
      expect(fr.map((r) => [r.displayName, r.direction])).toEqual([
        ["Chemise d'origine", "ltr"],
        ["قميص قديم", "ltr"],
        ["Uni", "ltr"],
      ]);
      // The record's English category, but the catalogue's French one for French.
      expect(fr[0].displayCategory).toBe("Chemises");
      expect(fr[1].displayCategory).toBe("Chemises");
      const en = (await resolve(w.companyId, structuredClone(rows), "en")) as Array<Record<string, unknown>>;
      expect(en.map((r) => r.displayName)).toEqual(["Snapshot shirt", "قميص قديم", "Uni"]);
      expect(en[0].displayCategory).toBe("Old");
      const ar = (await resolve(w.companyId, structuredClone(rows), "ar")) as Array<Record<string, unknown>>;
      expect(ar.map((r) => r.displayName)).toEqual(["Snapshot shirt", "قميص قديم", "Uni"]);
      expect(ar[1].displayCategory).toBe("فئة");
    });
  });

  it("rewrites legacy display fields only when asked", async () => {
    await withRolledBackPool(async (client) => {
      const w = await catalog(client);
      const row = () => ({
        productId: w.shirt,
        productNameAr: "قميص",
        productName: "Shirt",
        bale_name: "x",
        categoryName: "Shirts",
        category_name: "y",
      });
      const kept = (await resolve(w.companyId, row(), "ar")) as Record<string, unknown>;
      expect(kept).toMatchObject({ productName: "Shirt", bale_name: "x", categoryName: "Shirts", displayName: "قميص" });
      const rewritten = (await resolve(w.companyId, row(), "ar", true)) as Record<string, unknown>;
      expect(rewritten).toMatchObject({
        productName: "قميص",
        bale_name: "قميص",
        productNameEn: "Shirt",
        productNameAr: "قميص",
        categoryName: "قمصان",
        category_name: "قمصان",
      });
      expect(rewritten).not.toHaveProperty("baleName");

      const french = (await resolve(
        w.companyId,
        { productId: w.shirt, productNameFr: "Chemise", productNameEn: "E" },
        "fr",
        true
      )) as Record<string, unknown>;
      expect(french).toMatchObject({ productNameFr: "Chemise", productNameEn: "E" });

      const product = (await resolve(
        w.companyId,
        { articleCode: "AB-100", name: "  ", nameAr: null, description: null },
        "fr",
        true
      )) as Record<string, unknown>;
      expect(product).toMatchObject({ name: "Chemise coton", nameEn: "Cotton shirt", displayCategory: "Chemises" });
      const named = (await resolve(
        w.companyId,
        { articleCode: "AB-100", name: "Own", nameEn: "Kept" },
        "en",
        true
      )) as Record<string, unknown>;
      expect(named).toMatchObject({ name: "Own", nameEn: "Kept" });
    });
  });

  it("localizes category records without touching the catalogue", async () => {
    await withRolledBackPool(async (client) => {
      const w = await catalog(client);
      const categories = [
        { id: 1, name: "Shirts", nameAr: "قمصان", nameFr: null },
        { id: 2, name: "Pants", nameEn: "Trousers", nameFr: "Pantalons" },
        { id: 3, name: "  ", nameAr: "" },
      ];
      const ar = (await resolve(w.companyId, structuredClone(categories), "ar")) as Array<Record<string, unknown>>;
      expect(ar.map((c) => [c.displayName, c.displayCategoryName, c.direction, c.nameEn])).toEqual([
        ["قمصان", "قمصان", "rtl", "Shirts"],
        ["Trousers", "Trousers", "rtl", "Trousers"],
        ["", "", "rtl", undefined],
      ]);
      const fr = (await resolve(w.companyId, structuredClone(categories), "fr")) as Array<Record<string, unknown>>;
      expect(fr.map((c) => c.displayName)).toEqual(["Shirts", "Pantalons", ""]);
    });
  });

  it("leaves payloads with nothing to resolve unchanged", async () => {
    await withRolledBackPool(async (client) => {
      const w = await catalog(client);
      for (const payload of [
        null,
        5,
        "text",
        [],
        [{ id: 1, name: "No translations" }],
        { productId: w.shirt },
        { articleCode: "AB-100", qty: 1 },
      ]) {
        const before = JSON.stringify(payload);
        expect(JSON.stringify(await resolve(w.companyId, payload, "ar", true))).toBe(before);
      }
      // A non-positive id is not a product reference.
      expect(await resolve(w.companyId, { productId: -5, productName: "x" }, "ar")).not.toHaveProperty("displayName");
      // Another company's catalogue is never used.
      const other = await catalog(client);
      const foreign = (await resolve(other.companyId, { productId: w.shirt, productName: null }, "ar")) as Record<
        string,
        unknown
      >;
      expect(foreign).not.toHaveProperty("displayName");
    });
  });
});
