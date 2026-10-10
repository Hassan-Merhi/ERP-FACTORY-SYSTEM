import { describe, expect, it } from "vitest";
import { translateAutomaticPriorityPrintingText } from "./automaticPriorityPrintingTranslations";

describe("Automatic Priority Printing translations", () => {
  it("translates fixed interface text into Arabic and French", () => {
    expect(translateAutomaticPriorityPrintingText("Automatic loading on printing", "ar")).toBe(
      "التحميل التلقائي عند الطباعة"
    );
    expect(translateAutomaticPriorityPrintingText("Automatic loading on printing", "fr")).toBe(
      "Chargement automatique à l’impression"
    );
  });

  it("keeps runtime values when translating interpolated server messages", () => {
    expect(
      translateAutomaticPriorityPrintingText(
        "Bale REF000501 is on a customer loading. Remove it from the loading first.",
        "fr"
      )
    ).toBe("La balle REF000501 est sur un chargement client. Retirez-la d’abord du chargement.");
    expect(
      translateAutomaticPriorityPrintingText("Loading changed for REF9. Refresh before printing.", "ar")
    ).toContain("REF9");
  });

  it("translates the saved-color print and palette guard messages", () => {
    expect(
      translateAutomaticPriorityPrintingText("Priority color changed for REF7. Refresh before printing.", "fr")
    ).toBe("La couleur de priorité a changé pour REF7. Actualisez avant d’imprimer.");
    expect(translateAutomaticPriorityPrintingText("Incomplete priority reprint audit for REF7.", "ar")).toContain(
      "REF7"
    );
    expect(
      translateAutomaticPriorityPrintingText("Select one of the eleven approved Priority Scan colors.", "ar")
    ).toBe("اختر أحد ألوان المسح حسب الأولوية الأحد عشر المعتمدة.");
  });

  it("leaves unrelated text to other catalogs", () => {
    expect(translateAutomaticPriorityPrintingText("Save", "ar")).toBeNull();
  });
});
