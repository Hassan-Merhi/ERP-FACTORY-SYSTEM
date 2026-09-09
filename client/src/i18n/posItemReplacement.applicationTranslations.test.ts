import { describe, expect, it } from "vitest";

describe("POS item replacement translation runtime safety", () => {
  it("imports without evaluating page/server-only runtime variables", async () => {
    const translations = await import("./posItemReplacement.applicationTranslations");

    expect(translations.translatePosItemReplacementLiteral("Updated 1 POS sale", "fr")).toBe(
      "1 vente POS mise à jour"
    );
    expect(translations.translatePosItemReplacementLiteral("Updated 2 POS sales", "fr")).toBe(
      "2 ventes POS mises à jour"
    );
    expect(translations.translatePosItemReplacement("correctedTitle", "en")).toBe(
      "POS items corrected"
    );
  });
});
