import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

type Entry = Record<ApplicationLanguage, string>;

const entries: Entry[] = [
  // Accounting, vouchers and daybook
  { en: "Chart of Accounts", ar: "دليل الحسابات", fr: "Plan comptable" },
  { en: "General Ledger", ar: "دفتر الأستاذ العام", fr: "Grand livre" },
  { en: "Trial Balance", ar: "ميزان المراجعة", fr: "Balance générale" },
  { en: "Balance Sheet", ar: "الميزانية العمومية", fr: "Bilan" },
  { en: "Income Statement", ar: "قائمة الدخل", fr: "Compte de résultat" },
  { en: "Profit and Loss", ar: "الأرباح والخسائر", fr: "Profits et pertes" },
  { en: "Journal Entry", ar: "قيد يومية", fr: "Écriture comptable" },
  { en: "Journal Entries", ar: "قيود اليومية", fr: "Écritures comptables" },
  { en: "Payment Voucher", ar: "سند دفع", fr: "Bon de paiement" },
  { en: "Receipt Voucher", ar: "سند قبض", fr: "Bon d’encaissement" },
  { en: "Journal Voucher", ar: "سند قيد", fr: "Pièce de journal" },
  { en: "Contra Voucher", ar: "سند تحويل", fr: "Pièce de contrepartie" },
  { en: "Debit", ar: "مدين", fr: "Débit" },
  { en: "Credit", ar: "دائن", fr: "Crédit" },
  { en: "Opening Balance", ar: "الرصيد الافتتاحي", fr: "Solde d’ouverture" },
  { en: "Closing Balance", ar: "الرصيد الختامي", fr: "Solde de clôture" },
  { en: "Current Balance", ar: "الرصيد الحالي", fr: "Solde actuel" },
  { en: "Account Name", ar: "اسم الحساب", fr: "Nom du compte" },
  { en: "Account Code", ar: "رمز الحساب", fr: "Code du compte" },
  { en: "Account Type", ar: "نوع الحساب", fr: "Type de compte" },
  { en: "Posting Date", ar: "تاريخ الترحيل", fr: "Date de comptabilisation" },
  { en: "Transaction Date", ar: "تاريخ المعاملة", fr: "Date de transaction" },
  { en: "Narration", ar: "البيان", fr: "Libellé" },
  { en: "Reconciliation", ar: "التسوية", fr: "Rapprochement" },
  { en: "Reconciled", ar: "تمت التسوية", fr: "Rapproché" },
  { en: "Unreconciled", ar: "غير مسوى", fr: "Non rapproché" },
  { en: "Post Voucher", ar: "ترحيل السند", fr: "Comptabiliser la pièce" },
  { en: "Reverse Voucher", ar: "عكس السند", fr: "Contrepasser la pièce" },
  { en: "Voucher Number", ar: "رقم السند", fr: "Numéro de pièce" },

  // Historical documents and exports
  { en: "Invoice", ar: "فاتورة", fr: "Facture" },
  { en: "Proforma Invoice", ar: "فاتورة أولية", fr: "Facture proforma" },
  { en: "Loading List", ar: "قائمة التحميل", fr: "Liste de chargement" },
  { en: "Packing List", ar: "قائمة التعبئة", fr: "Liste de colisage" },
  { en: "Delivery Note", ar: "إشعار تسليم", fr: "Bon de livraison" },
  { en: "Stock Label", ar: "ملصق المخزون", fr: "Étiquette de stock" },
  { en: "Document Language", ar: "لغة المستند", fr: "Langue du document" },
  { en: "Historical Snapshot", ar: "لقطة تاريخية", fr: "Instantané historique" },
  { en: "Finalized Document", ar: "مستند نهائي", fr: "Document finalisé" },
  { en: "Export PDF", ar: "تصدير PDF", fr: "Exporter en PDF" },
  { en: "Download PDF", ar: "تنزيل PDF", fr: "Télécharger le PDF" },
  { en: "Download Excel", ar: "تنزيل Excel", fr: "Télécharger Excel" },
  { en: "Print Preview", ar: "معاينة الطباعة", fr: "Aperçu avant impression" },
  { en: "Send via WhatsApp", ar: "إرسال عبر واتساب", fr: "Envoyer via WhatsApp" },
  { en: "Share", ar: "مشاركة", fr: "Partager" },

  // Errors and validation
  { en: "Validation failed", ar: "فشل التحقق", fr: "Échec de la validation" },
  { en: "Permission denied", ar: "تم رفض الإذن", fr: "Permission refusée" },
  { en: "Not authorized", ar: "غير مصرح", fr: "Non autorisé" },
  { en: "Not found", ar: "غير موجود", fr: "Introuvable" },
  { en: "Request failed", ar: "فشل الطلب", fr: "Échec de la requête" },
  { en: "Export failed", ar: "فشل التصدير", fr: "Échec de l’exportation" },
  { en: "Import failed", ar: "فشل الاستيراد", fr: "Échec de l’importation" },
  { en: "Print failed", ar: "فشلت الطباعة", fr: "Échec de l’impression" },
  { en: "File not found", ar: "الملف غير موجود", fr: "Fichier introuvable" },
  { en: "Invalid date", ar: "تاريخ غير صالح", fr: "Date invalide" },
  { en: "Invalid amount", ar: "مبلغ غير صالح", fr: "Montant invalide" },
  { en: "Unable to load transactions.", ar: "تعذر تحميل المعاملات.", fr: "Impossible de charger les transactions." },
  {
    en: "Could not load All Daybook",
    ar: "تعذر تحميل كل دفتر اليومية",
    fr: "Impossible de charger le journal général",
  },
  {
    en: "Please complete all required fields",
    ar: "يرجى إكمال جميع الحقول المطلوبة",
    fr: "Veuillez remplir tous les champs obligatoires",
  },
  { en: "Changes saved successfully", ar: "تم حفظ التغييرات بنجاح", fr: "Modifications enregistrées" },
  { en: "Document generated successfully", ar: "تم إنشاء المستند بنجاح", fr: "Document généré avec succès" },
  {
    en: "Account migration from ${sourceCompany.name}: ${sourceVoucher.description || sourceVoucher.voucherNumber}",
    ar: "ترحيل الحساب من {0}: {1}",
    fr: "Migration du compte depuis {0} : {1}",
  },
];

const lookup = new Map<string, Entry>();
for (const entry of entries) {
  lookup.set(entry.en, entry);
  lookup.set(entry.ar, entry);
  lookup.set(entry.fr, entry);
}

export function translateAccountingDocumentText(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const entry = lookup.get(value.trim());
  return entry ? `${leading}${entry[language]}${trailing}` : null;
}

export const accountingDocumentTranslationEntries = entries;
