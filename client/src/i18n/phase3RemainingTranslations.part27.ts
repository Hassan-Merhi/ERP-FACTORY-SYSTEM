import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

/**
 * Clear live-loading status copy for reusable proformas. These labels avoid the
 * ambiguous "Reference" wording while keeping it explicit that off-proforma
 * articles are permitted during an independent loading.
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
    en: "Review this loading beside the reusable proforma. Quantities are not capped across loadings.",
    ar: "راجع هذا التحميل إلى جانب الفاتورة الأولية القابلة لإعادة الاستخدام. لا تُفرض حدود للكميات عبر التحميلات.",
    fr: "Examinez ce chargement avec la proforma réutilisable. Les quantités ne sont pas plafonnées entre les chargements.",
  },
  {
    en: "${extraArticles.length} not on proforma — allowed",
    ar: "{{0}} غير مدرج في الفاتورة الأولية — مسموح",
    fr: "{{0}} absent(s) de la proforma — autorisé(s)",
  },
];
