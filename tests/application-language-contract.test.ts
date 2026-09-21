import { describe, expect, it } from "vitest";
import {
  APPLICATION_LANGUAGES,
  DEFAULT_APPLICATION_LANGUAGE,
  TRANSLATION_PROTECTED_DATA_FIELDS,
  isRtlApplicationLanguage,
  parseApplicationLanguage,
} from "../shared/applicationLanguageContract";

import { loadApplicationTranslationCatalog, translateApplicationText } from "../client/src/i18n/applicationTranslations";

describe("application language contract", () => {
  it("supports exactly English Arabic and French", () => {
    expect(APPLICATION_LANGUAGES).toEqual(["en", "ar", "fr"]);
    expect(DEFAULT_APPLICATION_LANGUAGE).toBe("en");
  });

  it("defaults unsupported values to English", () => {
    expect(parseApplicationLanguage("fr")).toBe("fr");
    expect(parseApplicationLanguage("ar")).toBe("ar");
    expect(parseApplicationLanguage("de")).toBe("en");
    expect(parseApplicationLanguage(null)).toBe("en");
  });

  it("uses RTL only for Arabic", () => {
    expect(isRtlApplicationLanguage("ar")).toBe(true);
    expect(isRtlApplicationLanguage("en")).toBe(false);
    expect(isRtlApplicationLanguage("fr")).toBe(false);
  });

  it("keeps business identifiers outside the UI translation dictionary", () => {
    expect(TRANSLATION_PROTECTED_DATA_FIELDS).toEqual(
      expect.arrayContaining([
        "articleCode",
        "stockItemName",
        "stockGroupName",
        "accountCode",
        "containerNumber",
        "voucherNumber",
      ]),
    );
  });

  it("resolves typed UI text in all three languages after lazy locale loading", async () => {
    await Promise.all([loadApplicationTranslationCatalog("ar"), loadApplicationTranslationCatalog("fr")]);
    expect(translateApplicationText("language.label", "en")).toBe("Language");
    expect(translateApplicationText("language.label", "ar")).toBe("اللغة");
    expect(translateApplicationText("language.label", "fr")).toBe("Langue");
  });
});
