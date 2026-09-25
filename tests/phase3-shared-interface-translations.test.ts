import { describe, expect, it } from "vitest";
import {
  isPhase3SharedUiText,
  phase3SharedUiTranslations,
  translatePhase3SharedUiText,
} from "../client/src/i18n/sharedUiPhase3Translations";
import { phase3SharedUiTranslationsPart1 } from "../client/src/i18n/sharedUiPhase3Translations.part1";
import { phase3SharedUiTranslationsPart2 } from "../client/src/i18n/sharedUiPhase3Translations.part2";
import { phase3SharedUiTranslationsPart3 } from "../client/src/i18n/sharedUiPhase3Translations.part3";
import { phase3SharedUiTranslationsPart4 } from "../client/src/i18n/sharedUiPhase3Translations.part4";
import { phase3SharedUiTranslationsPart5 } from "../client/src/i18n/sharedUiPhase3Translations.part5";
import { phase3SharedUiTranslationsPart6 } from "../client/src/i18n/sharedUiPhase3Translations.part6";
import { phase3SharedUiTranslationsPart7 } from "../client/src/i18n/sharedUiPhase3Translations.part7";

const reviewedPhase3SharedUiTranslations = [
  ...phase3SharedUiTranslationsPart1,
  ...phase3SharedUiTranslationsPart2,
  ...phase3SharedUiTranslationsPart3,
  ...phase3SharedUiTranslationsPart4,
  ...phase3SharedUiTranslationsPart5,
  ...phase3SharedUiTranslationsPart6,
  ...phase3SharedUiTranslationsPart7,
] as const;

describe("Phase 3 shared interface translations", () => {
  it("covers every reviewed shared UI phrase exactly once", () => {
    // The reviewed shared-UI registry is the original seven parts. Phase 3
    // completion appends generated backlog parts to the aggregate registry,
    // so freeze the reviewed inventory itself rather than the completed
    // aggregate that intentionally grows during generation.
    expect(reviewedPhase3SharedUiTranslations).toHaveLength(598);
    expect(new Set(reviewedPhase3SharedUiTranslations.map((entry) => entry.en)).size).toBe(598);

    for (const entry of reviewedPhase3SharedUiTranslations) {
      expect(entry.en.trim()).not.toBe("");
      expect(entry.ar.trim()).not.toBe("");
      expect(entry.fr.trim()).not.toBe("");
    }

    expect(phase3SharedUiTranslations.length).toBeGreaterThanOrEqual(reviewedPhase3SharedUiTranslations.length);
  });

  it("translates the Activity by Company subtitle", () => {
    expect(translatePhase3SharedUiText("Offloaded containers & imports per day", "ar")).toBe(
      "الحاويات المفرغة والواردات يوميًا"
    );
    expect(translatePhase3SharedUiText("Offloaded containers & imports per day", "fr")).toBe(
      "Conteneurs déchargés et importations par jour"
    );
  });

  it("translates global navigation, status and offline messages", () => {
    expect(translatePhase3SharedUiText("Search pages...", "ar")).toBe("ابحث في الصفحات...");
    expect(translatePhase3SharedUiText("No pending actions", "fr")).toBe("Aucune action en attente");
    expect(translatePhase3SharedUiText("Page not available offline", "ar")).toBe("الصفحة غير متاحة دون اتصال");
  });

  it("translates the analytics sales panel exposed by the current-main split", () => {
    expect(translatePhase3SharedUiText("Sales by Location", "ar")).toBe("المبيعات حسب الموقع");
    expect(translatePhase3SharedUiText("Factory POS", "fr")).toBe("Point de vente usine");
    expect(translatePhase3SharedUiText("Total Transactions:", "fr")).toBe("Total des transactions :");
  });

  it("preserves dynamic business references while translating their interface message", () => {
    expect(translatePhase3SharedUiText("42 kg added to MIX-17", "ar")).toBe("تمت إضافة 42 كغ إلى MIX-17");
    expect(translatePhase3SharedUiText("Switched to GC Lshi #2", "fr")).toBe("Passage à GC Lshi #2");
    expect(translatePhase3SharedUiText("Mirror voucher PV-301 created.", "ar")).toBe("تم إنشاء السند المقابل PV-301.");
  });

  it("can switch directly between Arabic and French visible text", () => {
    expect(translatePhase3SharedUiText("اختصارات لوحة المفاتيح", "fr")).toBe("Raccourcis clavier");
    expect(translatePhase3SharedUiText("Aucune action en attente", "en")).toBe("No pending actions");
  });

  it("recognizes only reviewed shared interface copy", () => {
    expect(isPhase3SharedUiText("Search pages...")).toBe(true);
    expect(isPhase3SharedUiText("تم إنشاء السند المقابل PV-301.")).toBe(true);
    expect(isPhase3SharedUiText("CUSTOM-ITEM-001")).toBe(false);
  });

  it("does not translate unknown stored business values", () => {
    expect(translatePhase3SharedUiText("CUSTOM-ITEM-001", "ar")).toBeNull();
    expect(translatePhase3SharedUiText("Blue Denim", "fr")).toBeNull();
    expect(translatePhase3SharedUiText("Hassan Supplier Account", "ar")).toBeNull();
  });
});
