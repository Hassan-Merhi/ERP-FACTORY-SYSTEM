import { describe, expect, it } from "vitest";
import {
  isPhase4SupplierPartnerText,
  supplierPartnerPhase4Translations,
  translatePhase4SupplierPartnerText,
} from "../client/src/i18n/supplierPartnerPhase4Translations";

describe("Phase 4 Supplier Partner translations", () => {
  it("covers every reviewed Supplier Partner phrase exactly once", () => {
    // 235 frozen Phase 4 phrases plus sixteen reviewed current-main additions.
    expect(supplierPartnerPhase4Translations).toHaveLength(251);
    expect(new Set(supplierPartnerPhase4Translations.map((entry) => entry.en)).size).toBe(251);

    for (const entry of supplierPartnerPhase4Translations) {
      expect(entry.en.trim()).not.toBe("");
      expect(entry.ar.trim()).not.toBe("");
      expect(entry.fr.trim()).not.toBe("");
    }
  });

  it("translates Supplier Partner migration, reporting and setup copy", () => {
    expect(translatePhase4SupplierPartnerText("Source ERP Company", "ar")).toBe("شركة ERP المصدر");
    expect(translatePhase4SupplierPartnerText("Supplier Payable", "fr")).toBe("Montant dû au fournisseur");
    expect(translatePhase4SupplierPartnerText("Supplier Partner setup complete", "ar")).toBe("اكتمل إعداد شريك المورد");
    expect(translatePhase4SupplierPartnerText("Unresolved stock code", "fr")).toBe("Code de stock non résolu");
    expect(translatePhase4SupplierPartnerText("Link item first", "ar")).toBe("اربط الصنف أولاً");
    expect(translatePhase4SupplierPartnerText("Supplier Partner Setup", "fr")).toBe(
      "Configuration du Partenaire fournisseur"
    );
  });

  it("preserves dynamic company, voucher and migration identifiers", () => {
    expect(translatePhase4SupplierPartnerText("GC Lshi #2 (GCL2) created successfully.", "ar")).toBe(
      "تم إنشاء GC Lshi #2 (GCL2) بنجاح."
    );
    expect(translatePhase4SupplierPartnerText("Voucher PV-440 for $1500", "fr")).toBe("Pièce PV-440 de $1500");
    expect(translatePhase4SupplierPartnerText("4 charge mapping(s) need approval and 2 remain unmapped.", "ar")).toBe(
      "يحتاج 4 ربط رسوم إلى الموافقة ولا يزال 2 دون ربط."
    );
  });

  it("switches directly between translated languages", () => {
    expect(translatePhase4SupplierPartnerText("Société source introuvable", "ar")).toBe(
      "لم يتم العثور على الشركة المصدر"
    );
    expect(translatePhase4SupplierPartnerText("تم حظر إعداد التحويل التشغيلي. عالج جميع عناصر FAIL أولًا.", "en")).toBe(
      "Cutover preparation is blocked. Resolve all FAIL items first."
    );
  });

  it("recognizes reviewed dynamic messages but not stored business values", () => {
    expect(isPhase4SupplierPartnerText("Profit split for 2026-07 already exists")).toBe(true);
    expect(isPhase4SupplierPartnerText("CUSTOM-SUPPLIER-ACCOUNT")).toBe(false);
    expect(translatePhase4SupplierPartnerText("CUSTOM-SUPPLIER-ACCOUNT", "fr")).toBeNull();
    expect(translatePhase4SupplierPartnerText("SUP-001", "ar")).toBeNull();
  });
});
