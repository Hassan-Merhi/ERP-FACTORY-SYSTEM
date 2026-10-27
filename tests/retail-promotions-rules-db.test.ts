/**
 * Retail promotions: input validation, the active window, scope matching, the
 * best-promotion choice per line, and create/update/deactivate/list against
 * PostgreSQL in a rolled-back transaction.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  bestPromotionForLine,
  createRetailPromotion,
  deactivateRetailPromotion,
  isPromotionActiveAt,
  listActiveRetailPromotions,
  listRetailPromotions,
  promotionMatchesVariant,
  updateRetailPromotion,
  validateRetailPromotionInput,
  type RetailPromotionRow,
} from "../server/services/retail/retailPromotions";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const AT = new Date("2026-10-20T12:00:00Z");
const base = { name: "Sale", scope: "all" as const, discountType: "percent" as const, value: 10 };
const row = (over: Partial<RetailPromotionRow>): RetailPromotionRow => ({
  id: 1,
  companyId: 1,
  name: "P",
  scope: "all",
  brandId: null,
  productId: null,
  variantId: null,
  discountType: "percent",
  value: "10",
  startsAt: null,
  endsAt: null,
  active: true,
  priority: 0,
  ...over,
});
const ctx = { variantId: 30, productId: 20, brandId: 10 };

describe("validateRetailPromotionInput", () => {
  it("trims the name and fills defaults", () => {
    expect(validateRetailPromotionInput({ ...base, name: "  Black Friday  ", value: "15" as never })).toEqual({
      ...base,
      name: "Black Friday",
      value: 15,
      startsAt: null,
      endsAt: null,
      priority: 0,
      active: true,
    });
    expect(
      validateRetailPromotionInput({
        ...base,
        priority: 3,
        active: false,
        startsAt: "2026-10-01",
        endsAt: "2026-10-01",
      })
    ).toMatchObject({ priority: 3, active: false, startsAt: new Date("2026-10-01"), endsAt: new Date("2026-10-01") });
    expect(validateRetailPromotionInput({ ...base, priority: "x" as never }).priority).toBe(0);
  });

  it("rejects each invalid field", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: "   " }, "Promotion name is required"],
      [{ name: undefined }, "Promotion name is required"],
      [{ name: "x".repeat(161) }, "Promotion name cannot exceed 160 characters"],
      [{ scope: "category" }, "Invalid promotion scope"],
      [{ discountType: "bogo" }, "Invalid promotion discount type"],
      [{ value: 0 }, "Promotion value must be greater than zero"],
      [{ value: Number.NaN }, "Promotion value must be greater than zero"],
      [{ value: 100.01 }, "Promotion percent cannot exceed 100"],
      [{ scope: "brand" }, "Promotion scope 'brand' requires its brand id"],
      [{ scope: "product", brandId: 4 }, "Promotion scope 'product' requires its product id"],
      [{ scope: "variant" }, "Promotion scope 'variant' requires its variant id"],
      [{ startsAt: "soon" }, "Invalid promotion start date"],
      [{ endsAt: "later" }, "Invalid promotion end date"],
      [{ startsAt: "2026-10-02", endsAt: "2026-10-01" }, "Promotion end date cannot be before its start date"],
    ];
    for (const [over, message] of cases) {
      expect(() => validateRetailPromotionInput({ ...base, ...over } as never)).toThrow(message);
    }
    expect(validateRetailPromotionInput({ ...base, discountType: "fixed", value: 250 }).value).toBe(250);
    expect(validateRetailPromotionInput({ ...base, value: 100 }).value).toBe(100);
  });
});

describe("promotion matching", () => {
  it("is active only when enabled and inside its window, boundaries included", () => {
    expect(isPromotionActiveAt(row({}), AT)).toBe(true);
    expect(isPromotionActiveAt(row({ active: false }), AT)).toBe(false);
    expect(isPromotionActiveAt(row({ startsAt: AT, endsAt: AT }), AT)).toBe(true);
    expect(isPromotionActiveAt(row({ startsAt: new Date(AT.getTime() + 1) }), AT)).toBe(false);
    expect(isPromotionActiveAt(row({ endsAt: new Date(AT.getTime() - 1) }), AT)).toBe(false);
  });

  it("matches a variant by scope", () => {
    expect(promotionMatchesVariant(row({ scope: "all" }), ctx)).toBe(true);
    expect(promotionMatchesVariant(row({ scope: "brand", brandId: 10 }), ctx)).toBe(true);
    expect(promotionMatchesVariant(row({ scope: "brand", brandId: 11 }), ctx)).toBe(false);
    expect(promotionMatchesVariant(row({ scope: "brand", brandId: null }), { ...ctx, brandId: null })).toBe(false);
    expect(promotionMatchesVariant(row({ scope: "product", productId: 20 }), ctx)).toBe(true);
    expect(promotionMatchesVariant(row({ scope: "product", productId: null }), ctx)).toBe(false);
    expect(promotionMatchesVariant(row({ scope: "variant", variantId: 30 }), ctx)).toBe(true);
    expect(promotionMatchesVariant(row({ scope: "variant", variantId: 31 }), ctx)).toBe(false);
    expect(promotionMatchesVariant(row({ scope: "variant", variantId: null }), ctx)).toBe(false);
    expect(promotionMatchesVariant(row({ scope: "coupon" }), ctx)).toBe(false);
  });

  it("picks the highest priority, then the larger discount, then the newest", () => {
    const pick = (rows: RetailPromotionRow[], price = 50) => bestPromotionForLine(rows, ctx, price, AT)?.id ?? null;
    expect(pick([])).toBeNull();
    expect(
      pick([
        row({ id: 1, active: false }),
        row({ id: 2, scope: "brand", brandId: 99 }),
        row({ id: 3, value: "0" }),
        row({ id: 4, value: "abc" }),
      ])
    ).toBeNull();
    expect(pick([row({ id: 1, value: "10" }), row({ id: 2, value: "5", priority: 1 })])).toBe(2);
    expect(pick([row({ id: 1, priority: 2 }), row({ id: 2, priority: 1, value: "50" })])).toBe(1);
    expect(pick([row({ id: 1, value: "10" }), row({ id: 2, value: "20" })])).toBe(2);
    expect(pick([row({ id: 2, value: "20" }), row({ id: 1, value: "10" })])).toBe(2);
    expect(pick([row({ id: 5, value: "10" }), row({ id: 9, value: "10" }), row({ id: 7, value: "10" })])).toBe(9);
    // Fixed amounts are capped at the price; percents at 100%.
    expect(pick([row({ id: 1, discountType: "fixed", value: "80" }), row({ id: 2, value: "150" })])).toBe(2);
    expect(pick([row({ id: 1, discountType: "fixed", value: "6" }), row({ id: 2, value: "10" })])).toBe(1);
    expect(bestPromotionForLine([row({ id: 3, discountType: "fixed", value: "6.5" })], ctx, 50, AT)).toEqual({
      id: 3,
      discountType: "fixed",
      value: 6.5,
    });
    expect(bestPromotionForLine([row({ id: 4, discountType: "weird", value: "6" })], ctx, 50, AT)).toEqual({
      id: 4,
      discountType: "fixed",
      value: 6,
    });
    expect(bestPromotionForLine([row({ id: 1 })], ctx, 0, AT)).toBeNull();
    expect(bestPromotionForLine([row({ id: 1, endsAt: new Date(Date.now() + 60_000) })], ctx, 10)).toMatchObject({
      id: 1,
    });
  });
});

async function company(client: PoolClient) {
  const tag = `RPR${process.pid}x${Math.random().toString(36).slice(2, 8)}`;
  const companyId = Number(
    (await client.query("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [tag, tag])).rows[0].id
  );
  const brandId = Number(
    (
      await client.query(
        "INSERT INTO retail_brands(company_id,name,normalized_name) VALUES($1,'Nike','nike') RETURNING id",
        [companyId]
      )
    ).rows[0].id
  );
  const userId = String(
    (await client.query("INSERT INTO users(username,password) VALUES($1,'x') RETURNING id", [tag])).rows[0].id
  );
  return { companyId, brandId, userId };
}

describe("promotion storage", () => {
  it("creates, updates, lists and deactivates a company's promotions", async () => {
    await withRolledBackPool(async (client) => {
      const { companyId, brandId, userId } = await company(client);
      const other = await company(client);
      const brand = await createRetailPromotion(
        companyId,
        {
          ...base,
          name: " Nike week ",
          description: "  ",
          scope: "brand",
          brandId,
          productId: 5,
          value: 20,
          priority: 2,
        },
        userId
      );
      expect(brand).toMatchObject({
        companyId,
        name: "Nike week",
        description: null,
        scope: "brand",
        brandId,
        productId: null,
        variantId: null,
        value: "20.000000",
        active: true,
        priority: 2,
        createdBy: userId,
      });
      const later = await createRetailPromotion(
        companyId,
        {
          ...base,
          name: "Later",
          description: " Next month ",
          startsAt: "2026-12-01T00:00:00Z",
          endsAt: "2026-12-31T00:00:00Z",
        },
        userId
      );
      expect(later.description).toBe("Next month");
      const old = await createRetailPromotion(
        companyId,
        { ...base, name: "Old", endsAt: "2026-01-01T00:00:00Z" },
        userId
      );
      const off = await createRetailPromotion(companyId, { ...base, name: "Off", active: false }, userId);
      await createRetailPromotion(other.companyId, { ...base, name: "Elsewhere" }, other.userId);

      expect((await listActiveRetailPromotions(companyId, AT)).map((p) => p.name)).toEqual(["Nike week"]);
      expect(
        (await listActiveRetailPromotions(companyId, new Date("2026-12-15T00:00:00Z"))).map((p) => p.name)
      ).toEqual(["Nike week", "Later"]);
      // The window includes its first instant.
      expect(
        (await listActiveRetailPromotions(companyId, new Date("2026-12-01T00:00:00Z"))).map((p) => p.name)
      ).toContain("Later");
      expect((await listRetailPromotions(companyId)).map((p) => p.name)).toEqual(["Nike week", "Later", "Old", "Off"]);

      const moved = await updateRetailPromotion(companyId, brand.id, { scope: "all", value: 30, active: false });
      expect(moved).toMatchObject({
        scope: "all",
        brandId: null,
        value: "30.000000",
        active: false,
        priority: 2,
        name: "Nike week",
      });
      const kept = await updateRetailPromotion(companyId, later.id, {});
      expect(kept).toMatchObject({
        name: "Later",
        description: "Next month",
        startsAt: later.startsAt,
        endsAt: later.endsAt,
      });
      await expect(updateRetailPromotion(companyId, old.id, { discountType: "fixed", value: 0 })).rejects.toThrow(
        "Promotion value must be greater than zero"
      );
      expect(await updateRetailPromotion(other.companyId, old.id, { name: "Stolen" })).toBeNull();

      expect(await deactivateRetailPromotion(companyId, off.id)).toBe(true);
      expect(await deactivateRetailPromotion(other.companyId, later.id)).toBe(false);
      expect((await listRetailPromotions(companyId)).find((p) => p.id === later.id)?.active).toBe(true);
    });
  });
});
