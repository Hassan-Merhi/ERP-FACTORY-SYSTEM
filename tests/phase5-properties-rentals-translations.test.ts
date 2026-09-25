import { describe, expect, it } from "vitest";
import {
  isPhase5PropertiesRentalsText,
  propertiesRentalsPhase5Translations,
  translatePhase5PropertiesRentalsText,
} from "../client/src/i18n/propertiesRentalsPhase5Translations";

describe("Phase 5 Properties and Rentals translations", () => {
  it("covers every reviewed user-facing phrase exactly once", () => {
    expect(propertiesRentalsPhase5Translations).toHaveLength(186);
    expect(new Set(propertiesRentalsPhase5Translations.map((entry) => entry.en)).size).toBe(186);

    for (const entry of propertiesRentalsPhase5Translations) {
      expect(entry.en.trim()).not.toBe("");
      expect(entry.ar.trim()).not.toBe("");
      expect(entry.fr.trim()).not.toBe("");
    }
  });

  it("translates dashboard, contract, guarantee and payment copy", () => {
    expect(translatePhase5PropertiesRentalsText("Properties workspace", "ar")).toBe("مساحة عمل العقارات");
    expect(translatePhase5PropertiesRentalsText("Monthly Rental Amount *", "fr")).toBe("Montant du loyer mensuel *");
    expect(translatePhase5PropertiesRentalsText("Guarantee applied to rent", "ar")).toBe("تم استخدام الضمان كإيجار");
    expect(translatePhase5PropertiesRentalsText("Payment scheduled", "fr")).toBe("Paiement programmé");
  });

  it("translates the rentals stat labels and per-unit-type empty states", () => {
    expect(translatePhase5PropertiesRentalsText("OUTSTANDING", "ar")).toBe("المستحق");
    expect(translatePhase5PropertiesRentalsText("CREDIT", "fr")).toBe("CRÉDIT");
    expect(translatePhase5PropertiesRentalsText("No warehouses yet. Add your first unit above.", "ar")).toBe(
      "لا توجد مستودعات بعد. أضف أول وحدة أعلاه."
    );
    expect(translatePhase5PropertiesRentalsText("No shops yet. Add your first unit above.", "fr")).toBe(
      "Aucune boutique pour l’instant. Ajoutez votre première unité ci-dessus."
    );
  });

  it("preserves dynamic amounts, dates, contract ids and unit references", () => {
    expect(
      translatePhase5PropertiesRentalsText(
        "Payment of 500 scheduled for 2026-08-05 (today is 2026-08-03). It will be posted automatically on that date.",
        "ar"
      )
    ).toBe("تمت جدولة دفعة بقيمة 500 بتاريخ 2026-08-05 (اليوم هو 2026-08-03). وسيتم ترحيلها تلقائيًا في ذلك التاريخ.");
    expect(
      translatePhase5PropertiesRentalsText(
        "Premature accrual: month 2026-08 accrued before billing date 2026-08-20 (contract 77)",
        "fr"
      )
    ).toBe(
      "Régularisation prématurée : le mois 2026-08 a été comptabilisé avant la date de facturation 2026-08-20 (contrat 77)"
    );
    expect(translatePhase5PropertiesRentalsText("KOLWEZI/A1", "ar")).toBe("KOLWEZI/A1");
  });

  it("switches directly between Arabic and French", () => {
    expect(translatePhase5PropertiesRentalsText("لم يتم العثور على العقد", "fr")).toBe("Contrat introuvable");
    expect(translatePhase5PropertiesRentalsText("Magasins loués", "ar")).toBe("المتاجر المؤجرة");
  });

  it("recognizes reviewed messages but not stored business names", () => {
    expect(isPhase5PropertiesRentalsText("This unit is vacant. Start a new lease:")).toBe(true);
    expect(isPhase5PropertiesRentalsText("MOKIB WAREHOUSE A1")).toBe(false);
    expect(translatePhase5PropertiesRentalsText("MOKIB WAREHOUSE A1", "fr")).toBeNull();
    expect(translatePhase5PropertiesRentalsText("Jean Tenant", "ar")).toBeNull();
    expect(translatePhase5PropertiesRentalsText("LEASE-2026-009", "fr")).toBeNull();
  });
});
