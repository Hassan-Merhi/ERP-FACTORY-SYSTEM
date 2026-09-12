import { describe, expect, it } from "vitest";
import {
  backendMessagesPhase7Translations,
  isPhase7BackendMessageText,
  translatePhase7BackendMessageText,
} from "../client/src/i18n/backendMessagesPhase7Translations";

describe("Phase 7 backend-message translations", () => {
  it("covers every reviewed backend phrase exactly once", () => {
    // 644 frozen Phase 7 phrases plus the three bale-scanning and proforma-capacity
    // messages part12 gained with the scan-again-to-bypass flow, plus the global
    // API rate-limit message, plus the ten route-sweep validation messages the
    // restored backend-coverage suites require the API to answer with (400s
    // instead of 500s for unvalidated input).
    expect(backendMessagesPhase7Translations).toHaveLength(658);
    expect(new Set(backendMessagesPhase7Translations.map((entry) => entry.en)).size).toBe(658);

    for (const entry of backendMessagesPhase7Translations) {
      expect(entry.en.trim()).not.toBe("");
      expect(entry.ar.trim()).not.toBe("");
      expect(entry.fr.trim()).not.toBe("");
    }
  });

  it("translates the PO-import preview rejection", () => {
    expect(translatePhase7BackendMessageText("Container data not found in preview", "ar")).toBe(
      "لم يتم العثور على بيانات الحاوية في المعاينة"
    );
    expect(translatePhase7BackendMessageText("Container data not found in preview", "fr")).toBe(
      "Données du conteneur introuvables dans l\u2019aperçu"
    );
    expect(isPhase7BackendMessageText("Container data not found in preview")).toBe(true);
  });

  it("translates authentication, import, approval and operations messages", () => {
    expect(translatePhase7BackendMessageText("Search Stock Items", "ar")).toBe("البحث في عناصر المخزون");
    expect(translatePhase7BackendMessageText("Too many login attempts. Please try again later.", "fr")).toBe(
      "Trop de tentatives de connexion. Veuillez réessayer plus tard."
    );
    expect(translatePhase7BackendMessageText("No active WhatsApp recipients configured", "ar")).toBe(
      "لا يوجد مستلمون نشطون مهيؤون في واتساب"
    );
    expect(translatePhase7BackendMessageText("Security audit unavailable", "fr")).toBe(
      "Audit de sécurité indisponible"
    );
    expect(
      translatePhase7BackendMessageText("Golden Coast owner-withdrawal clearing account is duplicated", "fr")
    ).toBe("Le compte de compensation des retraits du propriétaire de Golden Coast est dupliqué");
    expect(
      translatePhase7BackendMessageText(
        "GC-OWNER-WITHDRAWAL is already used by another ledger role; repair the chart of accounts first",
        "ar"
      )
    ).toBe("GC-OWNER-WITHDRAWAL مستخدم بالفعل لدور آخر في دفتر الأستاذ؛ أصلح دليل الحسابات أولاً");
  });

  it("translates factory production bonus labels and templates", () => {
    expect(translatePhase7BackendMessageText("Production Bonus", "ar")).toBe("مكافأة الإنتاج");
    expect(translatePhase7BackendMessageText("Other Bonus", "fr")).toBe("Autre prime");
    expect(translatePhase7BackendMessageText("Copied settings from 2026-08-06", "fr")).toBe(
      "Paramètres copiés depuis le 2026-08-06"
    );
    expect(
      translatePhase7BackendMessageText(
        "Nadia belongs to multiple production positions on 2026-08-07. Select a Production Position before saving Stock Entry.",
        "ar"
      )
    ).toBe("العامل Nadia ينتمي إلى عدة مناصب إنتاج بتاريخ 2026-08-07. اختر منصب الإنتاج قبل حفظ إدخال المخزون.");
  });

  it("preserves business values while translating nested operational fragments", () => {
    expect(translatePhase7BackendMessageText("Import job JOB-42 not found", "ar")).toBe(
      "لم يتم العثور على مهمة الاستيراد JOB-42"
    );
    expect(translatePhase7BackendMessageText("Quantity 12 for stock item 44 exceeds available stock (8)", "fr")).toBe(
      "La quantité 12 de l’article de stock 44 dépasse le stock disponible (8)"
    );
    expect(translatePhase7BackendMessageText('Voucher JV-88: "Office rent" — 1,500 from Main Bank', "ar")).toBe(
      "السند JV-88: «Office rent» — 1,500 من Main Bank"
    );
    expect(
      translatePhase7BackendMessageText("Daily ZIP sent to WhatsApp — 3 companies (start → today) (1 skipped).", "fr")
    ).toBe("ZIP quotidien envoyé sur WhatsApp — 3 entreprise(s) (début → aujourd’hui) (1 ignorée(s)).");
    expect(translatePhase7BackendMessageText("Daily ZIP sent to WhatsApp — 3 companies (full history).", "ar")).toBe(
      "تم إرسال ملف ZIP اليومي إلى واتساب — 3 شركة (السجل الكامل)."
    );
  });

  it("switches directly between Arabic and French", () => {
    expect(translatePhase7BackendMessageText("تم رفض الوصول", "fr")).toBe("Accès refusé");
    expect(translatePhase7BackendMessageText("Compte introuvable", "ar")).toBe("لم يتم العثور على الحساب");
  });

  it("translates the route-sweep validation messages", () => {
    expect(translatePhase7BackendMessageText("enabled must be a boolean", "ar")).toBe(
      "يجب أن تكون enabled قيمة منطقية (true أو false)"
    );
    expect(translatePhase7BackendMessageText("date is required and must be a valid date", "fr")).toBe(
      "La date est requise et doit être une date valide"
    );
    expect(translatePhase7BackendMessageText("Metric not found", "ar")).toBe("لم يتم العثور على المقياس");
    expect(translatePhase7BackendMessageText("Invalid archive ID", "fr")).toBe("Identifiant d’archive non valide");
    expect(translatePhase7BackendMessageText("voucherType is required", "ar")).toBe("الحقل voucherType مطلوب");
    expect(translatePhase7BackendMessageText("totalAmount is required", "fr")).toBe("Le champ totalAmount est requis");
    expect(isPhase7BackendMessageText("each entry requires an integer metricId")).toBe(true);
  });

  it("recognizes reviewed messages without translating stored business values", () => {
    expect(isPhase7BackendMessageText("Request must be approved before it can be executed")).toBe(true);
    expect(isPhase7BackendMessageText("Production Bonus")).toBe(true);
    expect(isPhase7BackendMessageText("HMD INTERNATIONAL GROUP")).toBe(false);
    expect(translatePhase7BackendMessageText("HMD INTERNATIONAL GROUP", "ar")).toBeNull();
    expect(translatePhase7BackendMessageText("MSKU1786517", "fr")).toBeNull();
    expect(translatePhase7BackendMessageText("JV-2026-0042", "ar")).toBeNull();
  });
});
