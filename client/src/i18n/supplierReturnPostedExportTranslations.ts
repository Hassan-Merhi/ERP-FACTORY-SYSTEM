import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

/** Labels used in posted supplier return Excel downloads. */
export const supplierReturnPostedExportCopy = {
  en: {
    sourceSheet:"Posted Source Lines", allocationsSheet:"Original Input Allocations", summarySheet:"Posted Summary",
    lineId:"Return Line ID", article:"Article Code", item:"Item Name", offloadItem:"Offload Item ID",
    offload:"Offload ID", container:"Container", supplier:"Supplier", quantity:"Posted Quantity",
    purchase:"Purchase Rate USD", effective:"Effective Inventory Cost / Bale USD",
    credit:"Supplier Debit USD", inventory:"Inventory Credit USD", variance:"Signed Variance USD",
    voucher:"Voucher Number", voucherId:"Voucher ID", total:"TOTAL", inputRow:"Input Row",
    requestedArticle:"Requested Article", requestedQty:"Original Requested Qty",
    sourceContainer:"Source Container", allocatedQty:"Allocated Qty", returnLineId:"Source Return Line ID",
    legacy:"Legacy return: input-row allocations were not recorded",
    field:"Field", value:"Value", batch:"Return batch", returnDate:"Return date",
    file:"Source file", manual:"Manual", reason:"Reason", sourceLines:"Posted source lines",
    removed:"Quantity removed", exactNote:"Posted amounts are exact audited ledger amounts, not preview estimates",
    note:"Note",
  },
  ar: {
    sourceSheet:"بنود المرتجع المسجلة", allocationsSheet:"توزيع صفوف الإدخال الأصلية", summarySheet:"ملخص المرتجع المسجل",
    lineId:"رقم بند المرتجع", article:"رمز الصنف", item:"اسم الصنف", offloadItem:"رقم بند التفريغ",
    offload:"رقم التفريغ", container:"الحاوية", supplier:"المورد", quantity:"الكمية المسجلة",
    purchase:"سعر الشراء بالدولار", effective:"تكلفة المخزون الفعلية للبالة بالدولار",
    credit:"مدين المورد بالدولار", inventory:"دائن المخزون بالدولار", variance:"فرق التكلفة بالدولار",
    voucher:"رقم السند", voucherId:"معرّف السند", total:"الإجمالي", inputRow:"صف الإدخال",
    requestedArticle:"الصنف المطلوب", requestedQty:"الكمية الأصلية المطلوبة",
    sourceContainer:"الحاوية الأصلية", allocatedQty:"الكمية المخصصة", returnLineId:"رقم بند المرتجع الأصلي",
    legacy:"مرتجع قديم: لم تُحفظ تفاصيل توزيع صفوف الإدخال",
    field:"الحقل", value:"القيمة", batch:"دفعة المرتجع", returnDate:"تاريخ المرتجع",
    file:"الملف الأصلي", manual:"يدوي", reason:"السبب", sourceLines:"بنود المصادر المسجلة",
    removed:"الكمية المخصومة", exactNote:"المبالغ المسجلة مأخوذة من القيود المحاسبية الفعلية وليست تقديرات",
    note:"ملاحظة",
  },
  fr: {
    sourceSheet:"Lignes sources comptabilisées", allocationsSheet:"Répartition saisie initiale", summarySheet:"Résumé du retour comptabilisé",
    lineId:"ID ligne de retour", article:"Code article", item:"Désignation", offloadItem:"ID ligne déchargement",
    offload:"ID déchargement", container:"Conteneur", supplier:"Fournisseur", quantity:"Quantité comptabilisée",
    purchase:"Prix achat USD", effective:"Coût réel du stock par balle USD",
    credit:"Débit fournisseur USD", inventory:"Crédit stock USD", variance:"Écart signé USD",
    voucher:"Numéro écriture", voucherId:"ID écriture", total:"TOTAL", inputRow:"Ligne de saisie",
    requestedArticle:"Article demandé", requestedQty:"Quantité initiale demandée",
    sourceContainer:"Conteneur source", allocatedQty:"Quantité allouée", returnLineId:"ID ligne de retour source",
    legacy:"Retour historique : les répartitions de saisie n'ont pas été enregistrées",
    field:"Champ", value:"Valeur", batch:"Lot de retour", returnDate:"Date de retour",
    file:"Fichier source", manual:"Manuel", reason:"Motif", sourceLines:"Lignes sources comptabilisées",
    removed:"Quantité retirée", exactNote:"Les montants comptabilisés proviennent du grand livre, et non des estimations",
    note:"Note",
  },
} as const;

export function getSupplierReturnPostedExportCopy(language: ApplicationLanguage) {
  return supplierReturnPostedExportCopy[language];
}
