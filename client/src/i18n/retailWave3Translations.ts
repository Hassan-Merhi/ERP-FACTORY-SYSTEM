import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import { createPhase3TemplateTranslator } from "./phase3TemplateTranslationRuntime";
import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

export const retailWave3Translations: readonly Phase3SharedUiEntry[] = [
  { en: "Retail Dashboard", ar: "لوحة تحكم التجزئة", fr: "Tableau de bord de détail" },
  {
    en: "Sales, margin, inventory health, and variant-level reconciliation from the retail movement ledger.",
    ar: "المبيعات والهامش وسلامة المخزون والتسوية على مستوى المتغير من سجل حركة التجزئة.",
    fr: "Ventes, marge, santé du stock et rapprochement au niveau des variantes à partir du journal des mouvements de détail.",
  },
  {
    en: "Retail reporting is only available for Retail / Variant Inventory companies",
    ar: "تقارير التجزئة متاحة فقط لشركات مخزون التجزئة / المتغيرات",
    fr: "Les rapports de détail sont disponibles uniquement pour les sociétés Stock détail / variantes",
  },
  {
    en: "Retail reporting is only available for Retail / Variant Inventory companies.",
    ar: "تقارير التجزئة متاحة فقط لشركات مخزون التجزئة / المتغيرات.",
    fr: "Les rapports de détail sont disponibles uniquement pour les sociétés Stock détail / variantes.",
  },
  {
    en: "Retail catalog is only available for Retail / Variant Inventory companies",
    ar: "كتالوج التجزئة متاح فقط لشركات مخزون التجزئة / المتغيرات",
    fr: "Le catalogue de détail est disponible uniquement pour les sociétés Stock détail / variantes",
  },
  { en: "Gross profit", ar: "إجمالي الربح", fr: "Bénéfice brut" },
  { en: "Inventory value", ar: "قيمة المخزون", fr: "Valeur du stock" },
  { en: "Units sold", ar: "الوحدات المباعة", fr: "Unités vendues" },
  { en: "Best-selling products", ar: "المنتجات الأكثر مبيعًا", fr: "Produits les plus vendus" },
  { en: "Best-selling brands", ar: "العلامات الأكثر مبيعًا", fr: "Marques les plus vendues" },
  { en: "Best-selling sizes", ar: "المقاسات الأكثر مبيعًا", fr: "Tailles les plus vendues" },
  { en: "Sales by location", ar: "المبيعات حسب الموقع", fr: "Ventes par emplacement" },
  { en: "Low-stock items", ar: "أصناف منخفضة المخزون", fr: "Articles en stock faible" },
  { en: "Out-of-stock products", ar: "منتجات نفد مخزونها", fr: "Produits en rupture de stock" },
  { en: "Slow-moving inventory", ar: "مخزون بطيء الحركة", fr: "Stock à rotation lente" },
  { en: "Low at", ar: "منخفض في", fr: "Faible à" },
  { en: "Last sale", ar: "آخر عملية بيع", fr: "Dernière vente" },
  { en: "Loading retail reporting…", ar: "جارٍ تحميل تقارير التجزئة…", fr: "Chargement des rapports de détail…" },
  { en: "Nothing to review.", ar: "لا يوجد ما يمكن مراجعته.", fr: "Rien à examiner." },
  {
    en: "Could not load retail reporting.",
    ar: "تعذر تحميل تقارير التجزئة.",
    fr: "Impossible de charger les rapports de détail.",
  },
  {
    en: "Report start date must be before end date",
    ar: "يجب أن يكون تاريخ بداية التقرير قبل تاريخ النهاية",
    fr: "La date de début du rapport doit précéder la date de fin",
  },
  {
    en: "Retail report location is not active or does not belong to the selected company",
    ar: "موقع تقرير التجزئة غير نشط أو لا ينتمي إلى الشركة المحددة",
    fr: "L’emplacement du rapport de détail n’est pas actif ou n’appartient pas à la société sélectionnée",
  },
];

const exactTranslations = new Map<string, Phase3SharedUiEntry>();
for (const entry of retailWave3Translations) {
  if (!entry.en.includes("${")) exactTranslations.set(entry.en, entry);
}
const templateTranslator = createPhase3TemplateTranslator(retailWave3Translations);

export function isRetailWave3Text(value: string): boolean {
  const normalized = value.trim();
  return exactTranslations.has(normalized) || templateTranslator.matches(normalized);
}

export function translateRetailWave3Text(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  const exact = exactTranslations.get(normalized);
  if (exact) return `${leading}${exact[language]}${trailing}`;
  return templateTranslator.translate(value, language, (capture) => capture);
}
