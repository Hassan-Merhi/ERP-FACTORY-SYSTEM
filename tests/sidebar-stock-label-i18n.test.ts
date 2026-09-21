import { beforeAll, describe, expect, it } from "vitest";

import { loadApplicationTranslationCatalog } from "../client/src/i18n/applicationTranslations";
import { translateApplicationLiteral } from "../client/src/i18n/applicationLiteralTranslations";
import { translatePhase3SharedUiText } from "../client/src/i18n/sharedUiPhase3Translations";
import { translateSharedInterfaceText } from "../client/src/i18n/sharedInterfaceTranslations";

// The French word for "Inventory" is "Stock", which collides with the English
// "Stock" nav label. The interface translator matched that alias first and
// rendered the Stock item as a second "Inventory" entry in the sidebar.
describe("sidebar Stock label", () => {
  beforeAll(async () => {
    await Promise.all([loadApplicationTranslationCatalog("ar"), loadApplicationTranslationCatalog("fr")]);
  });

  it("does not resolve the English Stock label through a translated alias", () => {
    expect(translateApplicationLiteral("Stock", "en")).toBeNull();
  });

  it("keeps Stock spelled Stock in English", () => {
    expect(translatePhase3SharedUiText("Stock", "en")).toBe("Stock");
    expect(translateSharedInterfaceText("Stock", "en")).toBe("Stock");
  });

  it("still translates the Stock label", () => {
    expect(translateSharedInterfaceText("Stock", "ar")).toBe("المخزون");
    expect(translateSharedInterfaceText("Stock", "fr")).toBe("Stock");
  });

  it("still translates the Inventory label", () => {
    expect(translateApplicationLiteral("Inventory", "en")).toBe("Inventory");
    expect(translateApplicationLiteral("Inventory", "fr")).toBe("Stock");
  });
});
