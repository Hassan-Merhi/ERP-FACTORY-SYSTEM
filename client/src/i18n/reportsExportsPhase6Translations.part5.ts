import type { Phase6ReportsExportsEntry } from "./reportsExportsPhase6TranslationTypes";

/** Report compatibility messages added during the Phase 33 current-schema repair. */
export const reportsExportsPhase6TranslationsPart5: readonly Phase6ReportsExportsEntry[] = [
  {
    en: "Schema compatibility override references unknown report query type: ${queryType}",
    ar: "تجاوز توافق المخطط يشير إلى نوع استعلام تقرير غير معروف: {0}",
    fr: "Le remplacement de compatibilité du schéma référence un type de requête de rapport inconnu : {0}",
  },
  { en: "Workers / Payroll Rows", ar: "العمال / صفوف الرواتب", fr: "Travailleurs / lignes de paie" },
  { en: "Net Payroll", ar: "صافي الرواتب", fr: "Paie nette" },
  {
    en: "Cost Breakdown: ${container.container_number}",
    ar: "تفصيل التكلفة: {0}",
    fr: "Détail des coûts : {0}",
  },
  { en: "Item: ${item.name}", ar: "الصنف: {0}", fr: "Article : {0}" },
  {
    en: "Supplier Containers: ${rows.rows[0]?.supplier || supplierName}",
    ar: "حاويات المورد: {0}",
    fr: "Conteneurs du fournisseur : {0}",
  },
  { en: "Status Mix", ar: "مزيج الحالات", fr: "Répartition des statuts" },
  {
    en: "Schema compatibility report received unsupported query type: ${String(params.queryType)}",
    ar: "تقرير توافق المخطط تلقى نوع استعلام غير مدعوم: {0}",
    fr: "Le rapport de compatibilité du schéma a reçu un type de requête non pris en charge : {0}",
  },
  { en: "Stock Adjustments", ar: "تعديلات المخزون", fr: "Ajustements de stock" },
  {
    en: "Stock Adjustments Net Qty",
    ar: "صافي كمية تعديلات المخزون",
    fr: "Quantité nette des ajustements de stock",
  },
  { en: "Date", ar: "التاريخ", fr: "Date" },
  { en: "Voucher", ar: "السند", fr: "Pièce" },
  { en: "Type", ar: "النوع", fr: "Type" },
  { en: "Direction", ar: "الاتجاه", fr: "Sens" },
  { en: "Location", ar: "الموقع", fr: "Emplacement" },
  { en: "Item", ar: "الصنف", fr: "Article" },
  { en: "Qty", ar: "الكمية", fr: "Qté" },
  { en: "Rate", ar: "السعر", fr: "Taux" },
  { en: "Value", ar: "القيمة", fr: "Valeur" },
  { en: "Stock In", ar: "إدخال مخزون", fr: "Entrée de stock" },
  { en: "Stock Out", ar: "إخراج مخزون", fr: "Sortie de stock" },
  {
    en: "No stock adjustments found.",
    ar: "لم يتم العثور على تعديلات مخزون.",
    fr: "Aucun ajustement de stock trouvé.",
  },
  { en: "lines · In", ar: "أسطر · وارد", fr: "lignes · Entrées" },
  { en: "· Out", ar: "· صادر", fr: "· Sorties" },
];
