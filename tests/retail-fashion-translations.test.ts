import { describe, expect, it } from "vitest";
import {
  isRetailFashionText,
  retailFashionTranslations,
  translateRetailFashionText,
} from "../client/src/i18n/retailFashionTranslations";

const placeholders = (value: string) => value.match(/\$\{[^}]*\}/g) ?? [];
const positional = (value: string) => value.match(/\{\{\d+\}\}/g) ?? [];

describe("retail fashion EN / FR / AR copy", () => {
  it("has a non-empty Arabic and French value for every entry and no duplicates", () => {
    const seen = new Set<string>();
    for (const entry of retailFashionTranslations) {
      expect(entry.ar.trim(), entry.en).not.toBe("");
      expect(entry.fr.trim(), entry.en).not.toBe("");
      expect(seen.has(entry.en), `duplicate ${entry.en}`).toBe(false);
      seen.add(entry.en);
    }
  });

  it("keeps every template placeholder in both translations", () => {
    for (const entry of retailFashionTranslations) {
      const count = placeholders(entry.en).length;
      if (!count) continue;
      expect(positional(entry.ar).length, entry.en).toBe(count);
      expect(positional(entry.fr).length, entry.en).toBe(count);
      expect(entry.ar, entry.en).not.toContain("${");
      expect(entry.fr, entry.en).not.toContain("${");
    }
  });

  it("translates the core intake, label, POS and stock screens", () => {
    for (const text of [
      "Quick add fashion item",
      "Print barcode labels",
      "Scan or find item",
      "Stock operations",
      "Movement history",
      "Show archived items",
    ]) {
      expect(isRetailFashionText(text), text).toBe(true);
    }
    expect(translateRetailFashionText("Take photo", "ar")).toBe("التقاط صورة");
    expect(translateRetailFashionText("Take photo", "fr")).toBe("Prendre une photo");
    expect(translateRetailFashionText("Variant #3", "fr")).toBe("Variante n° 3");
    expect(translateRetailFashionText("Received 2 × Black / M", "ar")).toBe("تم استلام 2 × Black / M");
  });

  it("does not hijack unrelated text from other modules", () => {
    for (const text of ["Print shipping label", "Refund policy", "3 rows", "Paid / Unpaid", "Total"]) {
      expect(translateRetailFashionText(text, "ar"), text).toBeNull();
    }
  });
});
