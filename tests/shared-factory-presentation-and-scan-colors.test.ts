/**
 * Two small shared Factory helpers: the legacy bale edit mapping that keeps
 * Arabic text out of the English catalogue (and fallback text out of Arabic),
 * and the Priority Scan colour letters and ink.
 */
import { describe, expect, it } from "vitest";
import {
  mapFactoryLegacyProductEdit,
  suppressUnchangedFactoryArabicFallbacks,
} from "../shared/factoryBilingualCatalogPresentation";
import {
  DEFAULT_PRIORITY_SCAN_COLOR,
  getPriorityScanLetter,
  getPriorityScanLetterInk,
  isApprovedPriorityScanColor,
  PRIORITY_SCAN_COLORS,
} from "../shared/priorityScanColors";

describe("mapFactoryLegacyProductEdit", () => {
  it("defers Arabic-mode name and description edits to the Arabic fields", () => {
    expect(mapFactoryLegacyProductEdit({ name: " قميص ", description: "", price: 5 }, "ar")).toEqual({
      body: { price: 5 },
      deferredArabic: { nameAr: "قميص", descriptionAr: null },
    });
    expect(mapFactoryLegacyProductEdit({ name: null, description: 12 }, "ar")).toEqual({
      body: {},
      deferredArabic: { nameAr: null, descriptionAr: "12" },
    });
    expect(mapFactoryLegacyProductEdit({ price: 5 }, "ar")).toEqual({ body: { price: 5 }, deferredArabic: {} });
  });

  it("keeps English edits and always moves explicit Arabic fields aside", () => {
    expect(mapFactoryLegacyProductEdit({ name: "Shirt", nameAr: " ", descriptionAr: undefined }, "en")).toEqual({
      body: { name: "Shirt" },
      deferredArabic: { nameAr: null, descriptionAr: undefined },
    });
    // Explicit Arabic fields win over the Arabic-mode legacy name.
    expect(
      mapFactoryLegacyProductEdit({ name: "a", nameAr: "b", description: "c", descriptionAr: "d" }, "ar").deferredArabic
    ).toEqual({
      nameAr: "b",
      descriptionAr: "d",
    });
    expect(mapFactoryLegacyProductEdit({ name: "Chemise" }, "fr")).toEqual({
      body: { name: "Chemise" },
      deferredArabic: {},
    });
  });
});

describe("suppressUnchangedFactoryArabicFallbacks", () => {
  const current = { articleCode: "AB-1", name: "Shirt", nameAr: null, description: "Cotton", descriptionAr: null };
  it("drops Arabic values that only echo the English fallback", () => {
    expect(suppressUnchangedFactoryArabicFallbacks({ nameAr: "Shirt", descriptionAr: "Cotton" }, current)).toEqual({});
    expect(suppressUnchangedFactoryArabicFallbacks({ nameAr: "AB-1" }, { articleCode: "AB-1" })).toEqual({});
  });

  it("keeps real translations, edits of existing Arabic and absent fields", () => {
    expect(suppressUnchangedFactoryArabicFallbacks({ nameAr: "قميص", descriptionAr: "قطن" }, current)).toEqual({
      nameAr: "قميص",
      descriptionAr: "قطن",
    });
    expect(
      suppressUnchangedFactoryArabicFallbacks(
        { nameAr: "Shirt", descriptionAr: "Cotton" },
        { ...current, nameAr: "قديم", descriptionAr: "قديم" }
      )
    ).toEqual({ nameAr: "Shirt", descriptionAr: "Cotton" });
    // Resubmitting a real Arabic name unchanged is kept: it is not a fallback.
    expect(suppressUnchangedFactoryArabicFallbacks({ nameAr: "قديم" }, { ...current, nameAr: "قديم" })).toEqual({
      nameAr: "قديم",
    });
    expect(suppressUnchangedFactoryArabicFallbacks({}, current)).toEqual({});
    expect(suppressUnchangedFactoryArabicFallbacks({ nameAr: null }, current)).toEqual({ nameAr: null });
  });
});

describe("priority scan colours", () => {
  it("letters the approved palette case-insensitively and nothing else", () => {
    expect(DEFAULT_PRIORITY_SCAN_COLOR).toBe("#9400D3");
    expect(PRIORITY_SCAN_COLORS.map(getPriorityScanLetter).join("")).toBe("MNOPQRSTUVW");
    expect(getPriorityScanLetter("#b22222")).toBe("R");
    expect(getPriorityScanLetter("#123456")).toBeNull();
    expect(getPriorityScanLetter(7)).toBeNull();
    expect(isApprovedPriorityScanColor("#a7fc00")).toBe(true);
    expect(isApprovedPriorityScanColor("#A7FC01")).toBe(false);
    expect(isApprovedPriorityScanColor(null)).toBe(false);
  });

  it("chooses black ink on light swatches and white on dark or unknown ones", () => {
    const ink = Object.fromEntries(PRIORITY_SCAN_COLORS.map((color) => [color, getPriorityScanLetterInk(color)]));
    expect(ink).toEqual({
      "#9400D3": "#FFFFFF",
      "#F28500": "#000000",
      "#FFD700": "#000000",
      "#39FF14": "#000000",
      "#808000": "#000000",
      "#B22222": "#FFFFFF",
      "#6A5ACD": "#FFFFFF",
      "#000000": "#FFFFFF",
      "#B0E0E6": "#000000",
      "#DB7093": "#000000",
      "#A7FC00": "#000000",
    });
    expect(getPriorityScanLetterInk("#ffffff")).toBe("#FFFFFF");
    expect(getPriorityScanLetterInk(undefined)).toBe("#FFFFFF");
  });
});
