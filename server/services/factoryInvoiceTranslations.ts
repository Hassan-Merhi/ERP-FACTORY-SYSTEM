// Canonical invoice-only labels live here so document renderers share one trilingual source.
export const FACTORY_INVOICE_EXTRA_LABELS = {
  en: {
    category: "Category",
    unitPrice: "Unit Price",
    name: "Name",
    amount: "Amount",
    subtotalPrefix: "SUB-TOTAL",
    invalidWorkbook: "Generated invoice workbook is invalid",
    invalidPdf: "Generated invoice PDF is invalid",
  },
  ar: {
    category: "الفئة",
    unitPrice: "سعر الوحدة",
    name: "الاسم",
    amount: "المبلغ",
    subtotalPrefix: "المجموع الفرعي",
    invalidWorkbook: "ملف فاتورة Excel الذي تم إنشاؤه غير صالح",
    invalidPdf: "ملف PDF للفاتورة الذي تم إنشاؤه غير صالح",
  },
  fr: {
    category: "Catégorie",
    unitPrice: "Prix unitaire",
    name: "Nom",
    amount: "Montant",
    subtotalPrefix: "SOUS-TOTAL",
    invalidWorkbook: "Le classeur de facture généré est invalide",
    invalidPdf: "Le PDF de facture généré est invalide",
  },
} as const;
