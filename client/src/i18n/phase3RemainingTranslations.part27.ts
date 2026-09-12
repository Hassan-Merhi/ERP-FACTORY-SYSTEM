import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

/**
 * Live-loading comparison copy for reusable proformas. Statuses describe this
 * loading only and never re-enable cross-loading quantity enforcement.
 */
export const phase3RemainingTranslationsPart27: readonly Phase3SharedUiEntry[] = [
  {
    en: "On Proforma",
    ar: "مدرج في الفاتورة الأولية",
    fr: "Sur la proforma",
  },
  {
    en: "Not on Proforma — Allowed",
    ar: "غير مدرج في الفاتورة الأولية — مسموح",
    fr: "Absent de la proforma — Autorisé",
  },
  {
    en: "Reusable",
    ar: "قابلة لإعادة الاستخدام",
    fr: "Réutilisable",
  },
  {
    en: "Loaded",
    ar: "محمّل",
    fr: "Chargé",
  },
  {
    en: "Overloaded",
    ar: "تحميل زائد",
    fr: "Surchargé",
  },
  {
    en: "Less Loaded",
    ar: "تحميل أقل",
    fr: "Chargement insuffisant",
  },
  {
    en: "Missing",
    ar: "مفقود",
    fr: "Manquant",
  },
  {
    en: "Reusable proforma — this proforma does not cap this loading",
    ar: "فاتورة أولية قابلة لإعادة الاستخدام — هذه الفاتورة الأولية لا تفرض حداً على هذا التحميل",
    fr: "Proforma réutilisable — cette proforma ne limite pas ce chargement",
  },
  {
    en: "Reusable proforma — quantities are informational",
    ar: "فاتورة أولية قابلة لإعادة الاستخدام — الكميات للعرض فقط",
    fr: "Proforma réutilisable — les quantités sont indicatives",
  },
  {
    en: "Reusable proforma — statuses compare this loading only",
    ar: "فاتورة أولية قابلة لإعادة الاستخدام — الحالات تقارن هذا التحميل فقط",
    fr: "Proforma réutilisable — les statuts comparent uniquement ce chargement",
  },
  {
    en: "Review this loading beside the reusable proforma. Quantities are not capped across loadings.",
    ar: "راجع هذا التحميل إلى جانب الفاتورة الأولية القابلة لإعادة الاستخدام. لا تُفرض حدود للكميات عبر التحميلات.",
    fr: "Examinez ce chargement avec la proforma réutilisable. Les quantités ne sont pas plafonnées entre les chargements.",
  },
  {
    en: "Review this loading against the reusable proforma. Statuses are informational and apply to this loading only.",
    ar: "راجع هذا التحميل مقابل الفاتورة الأولية القابلة لإعادة الاستخدام. الحالات معلوماتية وتنطبق على هذا التحميل فقط.",
    fr: "Comparez ce chargement à la proforma réutilisable. Les statuts sont informatifs et s'appliquent uniquement à ce chargement.",
  },
  {
    en: "${loaded} loaded",
    ar: "{{0}} محمّل",
    fr: "{{0}} chargé(s)",
  },
  {
    en: "${overloaded} overloaded",
    ar: "{{0}} تحميل زائد",
    fr: "{{0}} surchargé(s)",
  },
  {
    en: "${lessLoaded} less loaded",
    ar: "{{0}} تحميل أقل",
    fr: "{{0}} chargement(s) insuffisant(s)",
  },
  {
    en: "${missing} missing",
    ar: "{{0}} مفقود",
    fr: "{{0}} manquant(s)",
  },
  {
    en: "${extraArticles.length} not on proforma — allowed",
    ar: "{{0}} غير مدرج في الفاتورة الأولية — مسموح",
    fr: "{{0}} absent(s) de la proforma — autorisé(s)",
  },
];
