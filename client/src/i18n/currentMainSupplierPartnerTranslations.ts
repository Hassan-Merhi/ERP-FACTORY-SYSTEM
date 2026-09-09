import type { Phase4SupplierPartnerEntry } from "./supplierPartnerPhase4TranslationTypes";

/**
 * Supplier Partner messages introduced on current main after the Phase 4
 * translation inventory was frozen. Keeping them here makes the compatibility
 * audit and the runtime interface translator use the same reviewed copy.
 */
export const currentMainSupplierPartnerTranslations = [
  {
    en: "Golden Coast POS is not ready for automatic HADI cash routing.",
    ar: "نقطة بيع Golden Coast غير جاهزة لتوجيه النقد تلقائياً إلى HADI.",
    fr: "Le point de vente Golden Coast n’est pas prêt pour l’acheminement automatique des espèces vers HADI.",
  },
  {
    en: "Golden Coast POS requires a stable client sale id.",
    ar: "تتطلب نقطة بيع Golden Coast معرّف بيع ثابتاً من العميل.",
    fr: "Le point de vente Golden Coast nécessite un identifiant de vente côté client stable.",
  },
  {
    en: "Unresolved stock code",
    ar: "رمز مخزون غير محلول",
    fr: "Code de stock non résolu",
  },
  {
    en: "Unresolved",
    ar: "غير محلول",
    fr: "Non résolu",
  },
  {
    en: "Link item first",
    ar: "اربط الصنف أولاً",
    fr: "Lier d’abord l’article",
  },
  {
    en: "proforma price",
    ar: "سعر الفاتورة الأولية",
    fr: "prix proforma",
  },
  {
    en: "Daily Supplier Partner work, reporting, stock setup, aliases, and account configuration.",
    ar: "العمل اليومي لشريك المورد والتقارير وإعداد المخزون والأسماء البديلة وتهيئة الحسابات.",
    fr: "Travail quotidien du Partenaire fournisseur, rapports, configuration du stock, alias et paramétrage des comptes.",
  },
  {
    en: "Profit & Loss and Sales Form export",
    ar: "تصدير الأرباح والخسائر ونموذج المبيعات",
    fr: "Export du compte de résultat et du formulaire de ventes",
  },
  {
    en: "Profit Split",
    ar: "توزيع الأرباح",
    fr: "Répartition du bénéfice",
  },
  {
    en: "Choose the report month and split it using the ledger-derived Golden Coast monthly close.",
    ar: "اختر شهر التقرير ووزّع الأرباح باستخدام الإقفال الشهري لغولدن كوست المستمد من دفتر الأستاذ.",
    fr: "Choisissez le mois du rapport et répartissez-le selon la clôture mensuelle Golden Coast issue du grand livre.",
  },
  {
    en: "Supplier Partner Setup",
    ar: "إعداد شريك المورد",
    fr: "Configuration du Partenaire fournisseur",
  },
  {
    en: "Configure and repair Supplier Partner accounts and links.",
    ar: "هيّئ حسابات وروابط شريك المورد وأصلحها.",
    fr: "Configurez et réparez les comptes et les liens du Partenaire fournisseur.",
  },
  {
    en: "Carry-forward status is unavailable",
    ar: "حالة الترحيل الافتتاحي غير متاحة",
    fr: "L’état du report est indisponible",
  },
  {
    en: "Golden Coast account setup is not configured for this company",
    ar: "إعداد حسابات غولدن كوست غير مهيأ لهذه الشركة",
    fr: "La configuration des comptes Golden Coast n’est pas définie pour cette société",
  },
  {
    en: "Golden Coast existing position carry-forward — ${GOLDEN_COAST_CUTOVER_DATE}",
    ar: "ترحيل المركز القائم لغولدن كوست — {0}",
    fr: "Report de la position existante Golden Coast — {0}",
  },
  {
    en: "Golden Coast current inventory cost lot from inventory #${row.inventoryId}",
    ar: "دفعة تكلفة المخزون الحالية لغولدن كوست من المخزون رقم {0}",
    fr: "Lot de coût de stock actuel Golden Coast provenant du stock n° {0}",
  },
] as const satisfies readonly Phase4SupplierPartnerEntry[];
