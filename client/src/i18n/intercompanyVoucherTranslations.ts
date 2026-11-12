import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

const en = {
  tab: "Intercompany Transfer",
  supplierExplanation:
    "Normal supplier payments stay in this company. A confirmed Properties-to-ERP cash or bank transfer must use the separate Intercompany Transfer voucher type.",
  openTransfer: "Intercompany Transfer",
  transferExplanation:
    "Select the involved Properties and ERP companies, their actual receiving and paying cash or bank accounts, date, currency, historical FX rate, transfer reference and proof. This posts one linked receipt and payment atomically; it is not a second supplier payment.",
  supplierPayment: "Normal Supplier Payment",
  transferVoucher: "Paired transfer vouchers",
  transferSafety:
    "Only confirm money that actually moved on both sides. The same transfer reference cannot be posted twice for a company pair. A remaining amount not assigned to a purchase order stays as unapplied credit, not another cash movement.",
  currentVoucher: "Voucher in this company",
  sourceReceipt: "Properties receipt",
  destinationPayment: "ERP payment",
  viewVoucher: "View voucher",
  voucherHistory: "Posted vouchers",
  voucherUnavailable: "No matching voucher in this company",
} as const;
type Labels = { [K in keyof typeof en]: string };
const translations: Record<ApplicationLanguage, Labels> = {
  en,
  fr: {
    tab: "Virement intersociétés",
    supplierExplanation:
      "Les paiements normaux aux fournisseurs restent dans cette société. Un transfert bancaire ou en espèces confirmé entre Propriétés et ERP doit utiliser le type Virement intersociétés.",
    openTransfer: "Virement intersociétés",
    transferExplanation:
      "Choisissez les sociétés Propriétés et ERP, les comptes réels d'encaissement et de paiement, la date, la devise, le taux historique, la référence et les justificatifs. Le reçu et le paiement sont comptabilisés ensemble, sans second paiement fournisseur.",
    supplierPayment: "Paiement fournisseur normal",
    transferVoucher: "Pièces de virement liées",
    transferSafety:
      "Confirmez uniquement les fonds effectivement transférés des deux côtés. Une référence ne peut pas être enregistrée deux fois pour la même paire. Le solde non affecté à un bon de commande reste un crédit disponible et non un nouveau mouvement bancaire.",
    currentVoucher: "Pièce de cette société",
    sourceReceipt: "Encaissement Propriétés",
    destinationPayment: "Paiement ERP",
    viewVoucher: "Ouvrir la pièce",
    voucherHistory: "Pièces comptabilisées",
    voucherUnavailable: "Aucune pièce correspondante dans cette société",
  },
  ar: {
    tab: "تحويل بين الشركات",
    supplierExplanation:
      "دفعات الموردين العادية تبقى ضمن الشركة نفسها. التحويل الفعلي المؤكد بين العقارات وERP يجب تسجيله في نوع تحويل بين الشركات.",
    openTransfer: "تحويل بين الشركات",
    transferExplanation:
      "اختر شركة العقارات وشركة ERP، وحسابي الاستلام والدفع الفعليين، والتاريخ والعملة وسعر الصرف التاريخي ومرجع التحويل والإثبات. يسجل النظام إيصالاً ودفعة مرتبطين في عملية واحدة دون تكرار دفع المورد.",
    supplierPayment: "دفع مورّد عادي",
    transferVoucher: "سندات التحويل المرتبطة",
    transferSafety:
      "أكد فقط الأموال التي انتقلت فعلياً من الطرفين. لا يمكن تسجيل المرجع نفسه مرتين للشركتين. المبلغ غير المخصص لأمر شراء يبقى رصيداً دائناً غير مطبق وليس حركة نقدية جديدة.",
    currentVoucher: "سند هذه الشركة",
    sourceReceipt: "إيصال العقارات",
    destinationPayment: "دفعة ERP",
    viewVoucher: "عرض السند",
    voucherHistory: "السندات المسجلة",
    voucherUnavailable: "لا يوجد سند مناسب في هذه الشركة",
  },
};
export function intercompanyVoucherText(language: ApplicationLanguage): Labels {
  return translations[language] ?? en;
}
export const INTERCOMPANY_VOUCHER_EN = en;
