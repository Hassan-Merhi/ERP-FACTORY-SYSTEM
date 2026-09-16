import { describe, expect, it } from "vitest";
import {
  isPhase6ReportsExportsText,
  reportsExportsPhase6Translations,
  translatePhase6ReportsExportsText,
} from "../client/src/i18n/reportsExportsPhase6Translations";

describe("Phase 6 Reports and Exports translations", () => {
  it("covers every reviewed reports and exports phrase exactly once", () => {
    expect(reportsExportsPhase6Translations).toHaveLength(262);
    expect(new Set(reportsExportsPhase6Translations.map((entry) => entry.en)).size).toBe(262);

    for (const entry of reportsExportsPhase6Translations) {
      expect(entry.en.trim()).not.toBe("");
      expect(entry.ar.trim()).not.toBe("");
      expect(entry.fr.trim()).not.toBe("");
    }
  });

  it("translates report labels, print errors and WhatsApp export states", () => {
    expect(translatePhase6ReportsExportsText("Container Profitability", "ar")).toBe("ربحية الحاوية");
    expect(translatePhase6ReportsExportsText("Cash Flow Summary", "fr")).toBe("Résumé des flux de trésorerie");
    expect(translatePhase6ReportsExportsText("QZ Tray library failed to load", "ar")).toBe("فشل تحميل مكتبة QZ Tray");
    expect(translatePhase6ReportsExportsText("WhatsApp sending is disabled", "fr")).toBe(
      "L’envoi WhatsApp est désactivé"
    );
    expect(translatePhase6ReportsExportsText("Could not parse CSV: Invalid Quotes", "ar")).toBe(
      "تعذر تحليل ملف CSV: Invalid Quotes"
    );
    expect(translatePhase6ReportsExportsText("CSV file is empty", "fr")).toBe("Le fichier CSV est vide");
    expect(translatePhase6ReportsExportsText("read: unsupported data type", "ar")).toBe(
      "القراءة: نوع بيانات غير مدعوم"
    );
  });

  it("translates Phase 33 schema-compatibility report messages", () => {
    expect(translatePhase6ReportsExportsText("Workers / Payroll Rows", "fr")).toBe(
      "Travailleurs / lignes de paie"
    );
    expect(translatePhase6ReportsExportsText("Cost Breakdown: MSKU1234567", "ar")).toBe(
      "تفصيل التكلفة: MSKU1234567"
    );
    expect(translatePhase6ReportsExportsText("Supplier Containers: BASMA UK", "fr")).toBe(
      "Conteneurs du fournisseur : BASMA UK"
    );
    expect(
      translatePhase6ReportsExportsText(
        "Schema compatibility report received unsupported query type: legacy_report",
        "ar"
      )
    ).toBe("تقرير توافق المخطط تلقى نوع استعلام غير مدعوم: legacy_report");
  });

  it("preserves dynamic report, export and delivery references", () => {
    expect(translatePhase6ReportsExportsText("Container: MSKU1786517", "ar")).toBe("الحاوية: MSKU1786517");
    expect(translatePhase6ReportsExportsText("Customer: GC Lshi", "fr")).toBe("Client : GC Lshi");
    expect(
      translatePhase6ReportsExportsText(
        "Export capacity reached (2 active, 4 queued). Try again after the current export finishes.",
        "ar"
      )
    ).toBe("تم بلوغ سعة التصدير (2 نشط، 4 في الانتظار). حاول مجددًا بعد انتهاء التصدير الحالي.");
    expect(translatePhase6ReportsExportsText("Stock PDF + Net Position Excel sent to 243900000000", "fr")).toBe(
      "PDF du stock et Excel de la position nette envoyés à 243900000000"
    );
  });

  it("switches directly between Arabic and French", () => {
    expect(translatePhase6ReportsExportsText("إجمالي قيمة المخزون", "fr")).toBe("Valeur totale du stock");
    expect(translatePhase6ReportsExportsText("Aucun conteneur", "ar")).toBe("لا توجد حاويات");
  });

  it("recognizes reviewed interface messages but not stored business identifiers", () => {
    expect(isPhase6ReportsExportsText("Worker Productivity Ranking")).toBe(true);
    expect(isPhase6ReportsExportsText("MSKU1786517")).toBe(false);
    expect(translatePhase6ReportsExportsText("MSKU1786517", "fr")).toBeNull();
    expect(translatePhase6ReportsExportsText("HMD Stock Group", "ar")).toBeNull();
    expect(translatePhase6ReportsExportsText("ACC-1000", "fr")).toBeNull();
  });
});
