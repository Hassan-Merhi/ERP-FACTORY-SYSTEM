import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

// Wave 8 release closeout, continued from part 2 (which reached the 900-line limit).
export const wave8ReleaseTranslationsPart3: readonly Phase3SharedUiEntry[] = [
  {
    en: "One or more selected companies could not be found",
    ar: "تعذر العثور على شركة أو أكثر من الشركات المحددة",
    fr: "Une ou plusieurs des sociétés sélectionnées sont introuvables",
  },
  {
    en: "Item Market Analysis can only compare ERP companies",
    ar: "لا يمكن لتحليل سوق الأصناف مقارنة سوى شركات ERP",
    fr: "L’analyse du marché des articles ne peut comparer que des sociétés ERP",
  },
  {
    en: "Load 250 more",
    ar: "تحميل 250 إضافية",
    fr: "Charger 250 de plus",
  },
  {
    en: "All Profit",
    ar: "كل الأرباح",
    fr: "Tous les bénéfices",
  },
  {
    en: "COGS Reconciliation",
    ar: "تسوية تكلفة البضاعة المباعة",
    fr: "Rapprochement du coût des ventes",
  },
  {
    en: "Adjusted Cost Profit",
    ar: "الربح بالتكلفة المعدّلة",
    fr: "Bénéfice au coût ajusté",
  },
  {
    en: "Freight + Charges: Included",
    ar: "الشحن + الرسوم: مشمولة",
    fr: "Fret + frais : inclus",
  },
  {
    en: "Freight + Charges: Excluded",
    ar: "الشحن + الرسوم: مستبعدة",
    fr: "Fret + frais : exclus",
  },
  {
    en: "Invoice Total (With Charges)",
    ar: "إجمالي الفاتورة (مع الرسوم)",
    fr: "Total de la facture (avec frais)",
  },
  {
    en: "Total Cost (With Charges)",
    ar: "إجمالي التكلفة (مع الرسوم)",
    fr: "Coût total (avec frais)",
  },
  {
    en: "Expand a customer to see each loading, verified or finalized invoice. Totals below include freight and extra charges.",
    ar: "وسّع العميل لعرض كل عملية تحميل أو فاتورة متحقق منها أو معتمدة. الإجماليات أدناه تشمل الشحن والرسوم الإضافية.",
    fr: "Développez un client pour voir chaque chargement ou facture vérifiée ou finalisée. Les totaux ci-dessous incluent le fret et les frais supplémentaires.",
  },
  {
    en: "Expand a customer to see each loading, verified or finalized invoice. Totals below exclude freight and extra charges.",
    ar: "وسّع العميل لعرض كل عملية تحميل أو فاتورة متحقق منها أو معتمدة. الإجماليات أدناه تستثني الشحن والرسوم الإضافية.",
    fr: "Développez un client pour voir chaque chargement ou facture vérifiée ou finalisée. Les totaux ci-dessous excluent le fret et les frais supplémentaires.",
  },
  {
    en: "Invalid includeCharges filter",
    ar: "عامل تصفية includeCharges غير صالح",
    fr: "Filtre includeCharges non valide",
  },
  {
    en: "Invalid payroll salary amounts",
    ar: "مبالغ رواتب غير صالحة في كشف الرواتب",
    fr: "Montants de salaire de paie non valides",
  },
  {
    en: "Commission amount must be a number",
    ar: "يجب أن يكون مبلغ العمولة رقماً",
    fr: "Le montant de la commission doit être un nombre",
  },
  {
    en: "Commission FX rate must be a number",
    ar: "يجب أن يكون سعر صرف العمولة رقماً",
    fr: "Le taux de change de la commission doit être un nombre",
  },
  // Full Item Market Analysis Excel export, including the error messages.
  {
    en: "Export Excel",
    ar: "تصدير Excel",
    fr: "Exporter vers Excel",
  },
  {
    en: "Exporting...",
    ar: "جارٍ التصدير...",
    fr: "Exportation en cours...",
  },
  {
    en: "Excel exported",
    ar: "تم تصدير ملف Excel",
    fr: "Fichier Excel exporté",
  },
  {
    en: "Exported ${groupedRows.length} items and ${rows.length} company-item records with current filters.",
    ar: "تم تصدير {{0}} صنفًا و{{1}} سجلًا للأصناف حسب الشركة باستخدام عوامل التصفية الحالية.",
    fr: "{{0}} articles et {{1}} enregistrements d’articles par société exportés avec les filtres actuels.",
  },
  {
    en: "Excel export failed",
    ar: "فشل تصدير ملف Excel",
    fr: "Échec de l’exportation Excel",
  },
  {
    en: "Could not generate the workbook.",
    ar: "تعذّر إنشاء مصنف Excel.",
    fr: "Impossible de générer le classeur Excel.",
  },
  {
    en: "Invalid sale-price export filters",
    ar: "عوامل تصفية تصدير أسعار البيع غير صالحة",
    fr: "Filtres d’exportation des prix de vente non valides",
  },
  {
    en: "Invalid or repeated companies or too many item IDs",
    ar: "شركات غير صالحة أو مكررة، أو عدد كبير جدًا من معرّفات الأصناف",
    fr: "Sociétés invalides ou en double, ou trop d’identifiants d’articles",
  },
  {
    en: "One or more companies could not be found",
    ar: "تعذر العثور على شركة واحدة أو أكثر",
    fr: "Une ou plusieurs sociétés sont introuvables",
  },
  {
    en: "Failed to export item sale price breakdown",
    ar: "فشل تصدير تفاصيل أسعار بيع الأصناف",
    fr: "Échec de l’exportation du détail des prix de vente des articles",
  },
];
