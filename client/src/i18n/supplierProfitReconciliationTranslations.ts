import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

/** Supplier profit reconciliation labels and API errors in English, Arabic, and French. */
const supplierProfitPhrases = [
  { en: "CONTAINERS", ar: "الحاويات", fr: "CONTENEURS" },
  { en: "STOCK + SALES", ar: "المخزون + المبيعات", fr: "STOCK + VENTES" },
  { en: "PROFIT & SUPPLIER BALANCE", ar: "الربح ورصيد المورد", fr: "BÉNÉFICE ET SOLDE FOURNISSEUR" },
  { en: "Sold bales", ar: "البالات المباعة", fr: "Balles vendues" },
  {
    en: "Stock in hand (including offloading cost)",
    ar: "المخزون المتوفر (يشمل تكلفة التفريغ)",
    fr: "Stock disponible (déchargement compris)",
  },
  { en: "Total stock + sales", ar: "إجمالي المخزون والمبيعات", fr: "Total stock + ventes" },
  { en: "Total cost of all containers", ar: "التكلفة الإجمالية لكل الحاويات", fr: "Coût total de tous les conteneurs" },
  { en: "Calculated profit from containers", ar: "الربح المحسوب من الحاويات", fr: "Bénéfice calculé des conteneurs" },
  {
    en: "Total profit on the system",
    ar: "إجمالي الربح المسجل في النظام",
    fr: "Bénéfice total enregistré dans le système",
  },
  { en: "Difference", ar: "الفرق", fr: "Écart" },
  { en: "Amount owed to supplier", ar: "المبلغ المستحق للمورد", fr: "Montant dû au fournisseur" },
  { en: "Choose a valid date range.", ar: "اختر نطاق تاريخ صالحًا.", fr: "Sélectionnez une plage de dates valide." },
  { en: "Calculating supplier amounts…", ar: "جارٍ حساب مبالغ المورد…", fr: "Calcul des montants du fournisseur…" },
  {
    en: "Unable to calculate supplier profit",
    ar: "تعذّر حساب ربح المورد",
    fr: "Impossible de calculer le bénéfice fournisseur",
  },
  { en: "Could not load suppliers", ar: "تعذر تحميل الموردين", fr: "Impossible de charger les fournisseurs" },
  { en: "Refresh", ar: "تحديث", fr: "Actualiser" },
  { en: "Select supplier", ar: "اختر المورد", fr: "Sélectionner un fournisseur" },
  { en: "Supplier", ar: "المورد", fr: "Fournisseur" },
  { en: "Day", ar: "اليوم", fr: "Jour" },
  { en: "Month", ar: "الشهر", fr: "Mois" },
  { en: "Year", ar: "السنة", fr: "Année" },
  { en: "From", ar: "من", fr: "Du" },
  { en: "To", ar: "إلى", fr: "Au" },
  { en: "Unavailable", ar: "غير متاح", fr: "Indisponible" },
  {
    en: "Container profit is an estimate; shared stock items can belong to other suppliers. Supplier balance comes from the ledger.",
    ar: "ربح الحاويات تقديري؛ قد تتبع أصناف المخزون المشتركة موردين آخرين. رصيد المورد مأخوذ من دفتر الحسابات.",
    fr: "Le bénéfice des conteneurs est estimé ; des articles communs peuvent provenir d'autres fournisseurs. Le solde vient du grand livre.",
  },
  {
    en: "Sales and offloaded receipts follow the selected dates. Stock, OTW and supplier balance are current; historical container profit is not calculated.",
    ar: "تتبع المبيعات والحاويات المفرغة التواريخ المختارة، أما المخزون والحاويات قيد النقل ورصيد المورد فهي قيم حالية؛ لا يُحسب ربح الحاويات التاريخي.",
    fr: "Les ventes et réceptions déchargées suivent les dates choisies. Le stock, les conteneurs en transit et le solde fournisseur sont actuels ; le bénéfice historique n’est pas calculé.",
  },
  { en: "Supplier Profit Reconciliation", ar: "تسوية أرباح الموردين", fr: "Rapprochement des bénéfices fournisseurs" },
  { en: "Stock group", ar: "مجموعة المخزون", fr: "Groupe de stock" },
  {
    en: "Items: trace receipts, sales, COGS and inventory",
    ar: "الأصناف: تتبع الوارد والمبيعات وتكلفة البضاعة والمخزون",
    fr: "Articles : réceptions, ventes, coûts des ventes et stocks",
  },
  { en: "Recorded sales lines", ar: "بنود المبيعات المسجلة", fr: "Lignes de vente enregistrées" },
  { en: "Offloaded supplier containers", ar: "حاويات المورد المفرغة", fr: "Conteneurs du fournisseur déchargés" },
  {
    en: "Current OTW containers (excluded from realized profit)",
    ar: "الحاويات قيد النقل حاليًا (مستبعدة من الربح المحقق)",
    fr: "Conteneurs en transit (exclus du bénéfice réalisé)",
  },
  {
    en: "Compare recorded Sales Report profit with source container costs. Read-only.",
    ar: "قارن الربح المسجل في تقرير المبيعات بتكاليف الحاويات الأصلية. للعرض فقط.",
    fr: "Comparez le bénéfice du rapport des ventes aux coûts des conteneurs d’origine. Lecture seule.",
  },
  { en: "No accounting changes", ar: "دون تعديلات محاسبية", fr: "Aucune modification comptable" },
  {
    en: "All groups (items received from supplier)",
    ar: "جميع المجموعات (الأصناف المستلمة من المورد)",
    fr: "Tous les groupes (articles reçus du fournisseur)",
  },
  { en: "Date selection", ar: "اختيار التاريخ", fr: "Sélection de dates" },
  { en: "All time", ar: "جميع الفترات", fr: "Toutes les périodes" },
  { en: "Specific day", ar: "يوم محدد", fr: "Jour précis" },
  { en: "Specific month", ar: "شهر محدد", fr: "Mois précis" },
  { en: "Specific year", ar: "سنة محددة", fr: "Année précise" },
  { en: "Custom date range", ar: "نطاق تاريخ مخصص", fr: "Plage de dates personnalisée" },
  {
    en: "Sales grouping (like Sales Report)",
    ar: "تجميع المبيعات (كما في تقرير المبيعات)",
    fr: "Regroupement des ventes (comme dans le rapport des ventes)",
  },
  {
    en: "Calculating recorded sales and tracing container costs…",
    ar: "جارٍ حساب المبيعات المسجلة وتتبع تكاليف الحاويات…",
    fr: "Calcul des ventes enregistrées et traçage des coûts des conteneurs…",
  },
  {
    en: "No container-linked suppliers in this company.",
    ar: "لا يوجد موردون مرتبطون بحاويات في هذه الشركة.",
    fr: "Aucun fournisseur lié à un conteneur dans cette société.",
  },
  { en: "Sales Report verification", ar: "التحقق من تقرير المبيعات", fr: "Vérification du rapport des ventes" },
  {
    en: "Sales Report cost profit vs saved sale-line profit",
    ar: "ربح التكلفة في تقرير المبيعات مقابل أرباح بنود البيع المحفوظة",
    fr: "Bénéfice du rapport des ventes contre bénéfice enregistré des lignes",
  },
  { en: "Open Sales Report", ar: "فتح تقرير المبيعات", fr: "Ouvrir le rapport des ventes" },
  {
    en: "Container and inventory reconciliation",
    ar: "تسوية الحاويات والمخزون",
    fr: "Rapprochement des conteneurs et des stocks",
  },
  {
    en: "Only first 1,000 item rows shown. Do not treat this as a complete reconciliation.",
    ar: "يُعرض أول ١٠٠٠ سطر فقط من الأصناف. لا تعتبر هذه تسوية مكتملة.",
    fr: "Seules les 1 000 premières lignes sont affichées. Ce rapprochement n’est pas complet.",
  },
  {
    en: "Showing latest 300 lines, while summary includes all eligible sales. Export is also limited to these 300 rows.",
    ar: "تُعرض أحدث ٣٠٠ سطر، بينما يشمل الملخص جميع المبيعات المؤهلة. يقتصر التصدير أيضًا على هذه الأسطر.",
    fr: "Les 300 dernières lignes sont affichées ; le résumé inclut toutes les ventes admissibles. L’export est limité à ces lignes.",
  },
  { en: "Item reconciliation", ar: "تسوية الأصناف", fr: "Rapprochement par article" },
  { en: "Sale vouchers", ar: "قيود المبيعات", fr: "Pièces de vente" },
  { en: "Offloaded containers", ar: "الحاويات المفرغة", fr: "Conteneurs déchargés" },
  { en: "OTW containers", ar: "الحاويات قيد النقل", fr: "Conteneurs en transit" },
  { en: "Supplier statement unavailable", ar: "كشف حساب المورد غير متاح", fr: "Relevé du fournisseur indisponible" },
  {
    en: "Choose a valid supplier and stock group",
    ar: "اختر موردًا ومجموعة مخزون صالحين",
    fr: "Choisissez un fournisseur et un groupe de stock valides",
  },
  {
    en: "Supplier has no containers in this company",
    ar: "لا توجد حاويات لهذا المورد في هذه الشركة",
    fr: "Ce fournisseur n’a aucun conteneur dans cette société",
  },
  {
    en: "Stock group not in active company",
    ar: "مجموعة المخزون لا تنتمي إلى الشركة الحالية",
    fr: "Ce groupe de stock n’appartient pas à la société active",
  },
] as const;

const translations = new Map<string, { en: string; ar: string; fr: string }>(
  supplierProfitPhrases.map(({ en, ar, fr }) => [en, { en, ar, fr }] as const)
);

export function isSupplierProfitReconciliationText(value: string): boolean {
  return translations.has(value.trim());
}

export function translateSupplierProfitReconciliationText(value: string, language: ApplicationLanguage): string | null {
  const entry = translations.get(value.trim());
  if (!entry) return null;
  return entry[language] || entry.en;
}
