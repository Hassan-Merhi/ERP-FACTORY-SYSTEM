import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

const copy = {
  productionTarget: { en: "Production Target (automatic)", fr: "Objectif de production (automatique)", ar: "هدف الإنتاج (تلقائي)" },
  selectSources: { en: "Select sources to calculate the target", fr: "Sélectionnez des sources pour calculer l'objectif", ar: "اختر المصادر لحساب الهدف" },
  tierLabel: { en: "{kg} kg → {ton} Tons", fr: "{kg} kg → {ton} tonnes", ar: "{kg} كغ ← {ton} طن" },
  tons: { en: "{ton} Tons", fr: "{ton} tonnes", ar: "{ton} طن" },
  advances: {
    en: "Automatically advances from 15 → 17.5 → 20 tons as total batch weight increases.",
    fr: "Passe automatiquement de 15 à 17,5 puis à 20 tonnes lorsque le poids du lot augmente.",
    ar: "يتغير الهدف تلقائيًا من 15 إلى 17.5 ثم 20 طن مع زيادة وزن الدفعة.",
  },
  reportTitle: { en: "Daily Mix Batch — Category Production Targets", fr: "Mélanges du jour — objectifs par catégorie", ar: "خلطات اليوم — أهداف الإنتاج حسب الفئة" },
  autoTarget: { en: "AUTO TARGET: {ton} TONS", fr: "OBJECTIF AUTO : {ton} TONNES", ar: "الهدف التلقائي: {ton} طن" },
  batchesForDateOne: { en: "1 batch included for this date", fr: "1 lot inclus pour cette date", ar: "دفعة واحدة ضمن هذا التاريخ" },
  batchesForDateMany: { en: "{count} batches included for this date", fr: "{count} lots inclus pour cette date", ar: "{count} دفعات ضمن هذا التاريخ" },
  totalWeight: { en: "TOTAL WEIGHT", fr: "POIDS TOTAL", ar: "الوزن الإجمالي" },
  recordedCost: { en: "RECORDED TOTAL COST", fr: "COÛT TOTAL ENREGISTRÉ", ar: "التكلفة الإجمالية المسجلة" },
  blendedCost: { en: "BLENDED COST/KG", fr: "COÛT MOYEN/KG", ar: "متوسط التكلفة/كغ" },
  category: { en: "CATEGORY", fr: "CATÉGORIE", ar: "الفئة" },
  actual: { en: "ACTUAL KG", fr: "KG RÉELS", ar: "الكمية الفعلية كغ" },
  average: { en: "AVG $/KG", fr: "MOY. $/KG", ar: "متوسط $/كغ" },
  totalCost: { en: "TOTAL COST", fr: "COÛT TOTAL", ar: "التكلفة الإجمالية" },
  targetToday: { en: "TARGET TODAY", fr: "OBJECTIF DU JOUR", ar: "هدف اليوم" },
  difference: { en: "+/- KG", fr: "ÉCART KG", ar: "الفارق كغ" },
  total: { en: "TOTAL", fr: "TOTAL", ar: "الإجمالي" },
  unknownSource: { en: "Existing Batch / Unmapped", fr: "Lot existant / non attribué", ar: "دفعة سابقة / غير مُصنّف" },
  uncategorized: { en: "Uncategorized", fr: "Sans catégorie", ar: "غير مُصنّف" },
  foot: {
    en: "Targets use the saved Fixed Production Planner values when this report is generated. Actual weight and cost use recorded batch sources. Unassigned batch sources have no invented category target.",
    fr: "Les objectifs proviennent du plan fixe enregistré lors de la création de ce rapport. Poids et coûts proviennent des sources enregistrées. Aucun objectif n'est inventé pour les sources non attribuées.",
    ar: "تعتمد الأهداف على خطة الإنتاج الثابتة المحفوظة عند إنشاء التقرير. الوزن والتكلفة حسب المصادر المسجلة. لا يتم تعيين هدف افتراضي للمصادر غير المصنفة.",
  },
  planMissing: { en: "No saved production plan is available.", fr: "Aucun plan de production enregistré n'est disponible.", ar: "لا توجد خطة إنتاج محفوظة." },
} as const;

export type MixBatchCategoryTargetTranslationKey = keyof typeof copy;
export function mixBatchTargetTranslation(
  key: MixBatchCategoryTargetTranslationKey,
  language: ApplicationLanguage,
  values?: Record<string, string | number>,
): string {
  const item = copy[key];
  const template: string = item[language] || item.en;
  return template.replace(/\{(\w+)\}/g, (token, keyName: string) => {
    const value = values?.[keyName];
    return value === undefined ? token : String(value);
  });
}
