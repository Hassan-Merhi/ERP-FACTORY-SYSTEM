// Canonical invoice-only labels live here so document renderers share one trilingual source.\nexport const FACTORY_INVOICE_EXTRA_LABELS = {
  en: {
    category: "Category",
    unitPrice: "Unit Price",
    name: "Name",
    amount: "Amount",
    invalidWorkbook: "Generated invoice workbook is invalid",
    invalidPdf: "Generated invoice PDF is invalid",
  },
  ar: {
    category: "الفئة",
    unitPrice: "سعر الوحدة",
    name: "الاسم",
    amount: "المبلغ",
    invalidWorkbook: "ملف فاتورة Excel الذي تم إنشاؤه غير صالح",
    invalidPdf: "ملف PDF للفاتورة الذي تم إنشاؤه غير صالح",
  },
  fr: {
    category: "Catégorie",
    unitPrice: "Prix unitaire",
    name: "Nom",
    amount: "Montant",
    invalidWorkbook: "Le classeur de facture généré est invalide",
    invalidPdf: "Le PDF de facture généré est invalide",
  },
} as const;
