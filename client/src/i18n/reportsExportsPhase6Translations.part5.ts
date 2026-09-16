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
];
