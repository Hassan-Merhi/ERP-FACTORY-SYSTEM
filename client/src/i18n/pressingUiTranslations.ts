import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

/** New pressing dashboard copy uses the same three app languages as Factory. */
const pressingUiTranslations = {
  hourTargetDescription: {
    en: "KG per worker for this hour on the selected day",
    ar: "الكيلوغرام المستهدف لكل عامل في هذه الساعة من اليوم المحدد",
    fr: "KG par ouvrier pour cette heure du jour sélectionné",
  },
  saveHourTarget: {
    en: "Save target for this hour",
    ar: "حفظ هدف هذه الساعة",
    fr: "Enregistrer l’objectif de cette heure",
  },
  hourTargetHeader: {
    en: "Target (per worker)",
    ar: "الهدف (لكل عامل)",
    fr: "Objectif (par ouvrier)",
  },
  noWorkersConfigured: {
    en: "No workers configured",
    ar: "لم تتم تهيئة أي عامل",
    fr: "Aucun ouvrier configuré",
  },
  workerDefaults: {
    en: "Worker defaults",
    ar: "الأهداف الافتراضية للعمال",
    fr: "Objectifs par défaut des ouvriers",
  },
  noProductionHours: {
    en: "No production hours to show for this date.",
    ar: "لا توجد ساعات إنتاج لعرضها في هذا التاريخ.",
    fr: "Aucune heure de production à afficher pour cette date.",
  },
  upcoming: {
    en: "Upcoming",
    ar: "قادمة",
    fr: "À venir",
  },
  aboveTarget: {
    en: "Above target",
    ar: "فوق الهدف",
    fr: "Au-dessus de l’objectif",
  },
  belowTarget: {
    en: "Below target",
    ar: "دون الهدف",
    fr: "En dessous de l’objectif",
  },
  invalidTargetDescription: {
    en: "Enter a target above 0 and at most 100,000 KG.",
    ar: "أدخل هدفاً أكبر من صفر ولا يتجاوز 100,000 كغ.",
    fr: "Saisissez un objectif supérieur à 0 et inférieur ou égal à 100 000 KG.",
  },
  totalWeight: {
    en: "Total weight",
    ar: "الوزن الإجمالي",
    fr: "Poids total",
  },
  barcodeScan: {
    en: "Barcode Scan",
    ar: "مسح الباركود",
    fr: "Scan du code-barres",
  },
  totalBales: {
    en: "Total bales",
    ar: "إجمالي البالات",
    fr: "Total des balles",
  },
  producedBales: {
    en: "Produced bales",
    ar: "البالات المنتجة",
    fr: "Balles produites",
  },
} as const;

export type PressingUiTranslationKey = keyof typeof pressingUiTranslations;

export function translatePressingUiText(
  key: PressingUiTranslationKey,
  language: ApplicationLanguage,
): string {
  const value = pressingUiTranslations[key];
  return value[language] || value.en;
}
