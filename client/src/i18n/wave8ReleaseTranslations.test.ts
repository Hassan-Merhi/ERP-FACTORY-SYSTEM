import { describe, expect, it } from "vitest";
import { isWave8ReleaseText, translateWave8ReleaseText, wave8ReleaseTranslations } from "./wave8ReleaseTranslations";

describe("Wave 8 release translations", () => {
  it("provides unique English keys with Arabic and French text for every entry", () => {
    const english = wave8ReleaseTranslations.map((entry) => entry.en);
    expect(new Set(english).size).toBe(english.length);
    for (const entry of wave8ReleaseTranslations) {
      expect(entry.ar.trim()).not.toBe("");
      expect(entry.fr.trim()).not.toBe("");
      expect(entry.ar).not.toBe(entry.en);
    }
  });

  it("keeps template placeholders aligned across languages", () => {
    for (const entry of wave8ReleaseTranslations) {
      const placeholders = entry.en.split("${").length - 1;
      for (const text of [entry.ar, entry.fr]) {
        for (let index = 0; index < placeholders; index += 1) expect(text).toContain(`{{${index}}}`);
        expect(text).not.toContain(`{{${placeholders}}}`);
      }
    }
  });

  it("translates exact interface and API messages while preserving whitespace", () => {
    expect(isWave8ReleaseText("Stock Bale List")).toBe(true);
    expect(translateWave8ReleaseText("Stock Bale List", "ar")).toBe("قائمة بالات المخزون");
    expect(translateWave8ReleaseText("  Worker link not found ", "fr")).toBe("  Lien d’ouvrier introuvable ");
    expect(translateWave8ReleaseText("Stock Bale List", "en")).toBe("Stock Bale List");
  });

  it("translates rendered template messages with their captured values", () => {
    expect(isWave8ReleaseText("Prepaid charge #42 not found for this company")).toBe(true);
    expect(translateWave8ReleaseText("Prepaid charge #42 not found for this company", "fr")).toBe(
      "Frais prépayés n°42 introuvables pour cette société"
    );
    expect(translateWave8ReleaseText("This container is already SHIPPED.", "ar")).toBe(
      "هذه الحاوية بالفعل بحالة SHIPPED."
    );
  });

  it("leaves unrelated text untouched", () => {
    expect(isWave8ReleaseText("Completely unrelated sentence")).toBe(false);
    expect(translateWave8ReleaseText("Completely unrelated sentence", "fr")).toBeNull();
  });
});
