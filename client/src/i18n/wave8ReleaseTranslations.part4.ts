import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

// Wave 8 release closeout, continued from part 3 (which reached the 900-line limit).
export const wave8ReleaseTranslationsPart4: readonly Phase3SharedUiEntry[] = [
  {
    en: "Reason…",
    ar: "السبب…",
    fr: "Motif…",
  },
  {
    en: "Choose a cash movement reason",
    ar: "اختر سبب حركة النقد",
    fr: "Choisissez un motif de mouvement de caisse",
  },
  {
    en: "Cash movement accounts",
    ar: "حسابات حركات النقد",
    fr: "Comptes des mouvements de caisse",
  },
  {
    en: "No account (movements refused)",
    ar: "لا يوجد حساب (تُرفض الحركات)",
    fr: "Aucun compte (mouvements refusés)",
  },
  {
    en: "Save cash movement accounts",
    ar: "حفظ حسابات حركات النقد",
    fr: "Enregistrer les comptes des mouvements de caisse",
  },
  {
    en: "Retail inventory in the ledger",
    ar: "مخزون التجزئة في دفتر الأستاذ",
    fr: "Stock de détail dans le grand livre",
  },
  {
    en: "Stock sub-ledger",
    ar: "دفتر المخزون الفرعي",
    fr: "Sous-registre du stock",
  },
  {
    en: "Preview opening",
    ar: "معاينة الرصيد الافتتاحي",
    fr: "Aperçu de l’ouverture",
  },
  {
    en: "Apply opening",
    ar: "تطبيق الرصيد الافتتاحي",
    fr: "Appliquer l’ouverture",
  },
  {
    en: "Cash movement accounts saved",
    ar: "تم حفظ حسابات حركات النقد",
    fr: "Comptes des mouvements de caisse enregistrés",
  },
  {
    en: "Could not save cash movement accounts",
    ar: "تعذّر حفظ حسابات حركات النقد",
    fr: "Impossible d’enregistrer les comptes des mouvements de caisse",
  },
  {
    en: "Could not preview the opening",
    ar: "تعذّرت معاينة الرصيد الافتتاحي",
    fr: "Impossible d’afficher l’aperçu de l’ouverture",
  },
  {
    en: "Retail inventory opening applied",
    ar: "تم تطبيق الرصيد الافتتاحي لمخزون التجزئة",
    fr: "Ouverture du stock de détail appliquée",
  },
  {
    en: "Could not apply the opening",
    ar: "تعذّر تطبيق الرصيد الافتتاحي",
    fr: "Impossible d’appliquer l’ouverture",
  },
  {
    en: "Preview the opening first",
    ar: "اعرض معاينة الرصيد الافتتاحي أولاً",
    fr: "Affichez d’abord l’aperçu de l’ouverture",
  },
  {
    en: "Retail return #${returned.returnId} for sale #${saleId}",
    ar: "مرتجع تجزئة #{{0}} للبيع #{{1}}",
    fr: "Retour de détail n° {{0}} pour la vente n° {{1}}",
  },
  {
    en: "Retail return #${returned.returnId} for sale #${body.saleId}",
    ar: "مرتجع تجزئة #{{0}} للبيع #{{1}}",
    fr: "Retour de détail n° {{0}} pour la vente n° {{1}}",
  },
  {
    en: "Retail stock transfer #${operation.id}",
    ar: "تحويل مخزون تجزئة #{{0}}",
    fr: "Transfert de stock de détail n° {{0}}",
  },
  {
    en: "Retail stock adjustment #${operation.id} · ${body.reason}",
    ar: "تسوية مخزون تجزئة #{{0}} · {{1}}",
    fr: "Ajustement de stock de détail n° {{0}} · {{1}}",
  },
  {
    en: "Retail cancellation of sale #${saleId}",
    ar: "إلغاء بيع تجزئة #{{0}}",
    fr: "Annulation de la vente de détail n° {{0}}",
  },
  {
    en: "Retail stock receipt #${operation.id}",
    ar: "استلام مخزون تجزئة #{{0}}",
    fr: "Réception de stock de détail n° {{0}}",
  },
  {
    en: "Retail new item intake #${operation.id} · variant ${created.id}",
    ar: "إدخال صنف تجزئة جديد #{{0}} · المتغير {{1}}",
    fr: "Entrée d’un nouvel article de détail n° {{0}} · variante {{1}}",
  },
  {
    en: "Retail stock import ${importBatchKey}",
    ar: "استيراد مخزون تجزئة {{0}}",
    fr: "Import de stock de détail {{0}}",
  },
  {
    en: "Cash in from the bank",
    ar: "إيداع نقدي من البنك",
    fr: "Entrée de caisse depuis la banque",
  },
  {
    en: "Cash in from the owner",
    ar: "إيداع نقدي من المالك",
    fr: "Entrée de caisse apportée par le propriétaire",
  },
  {
    en: "Expense paid from the drawer",
    ar: "مصروف مدفوع من الدرج",
    fr: "Dépense payée depuis la caisse",
  },
  {
    en: "Cash drop to the safe or bank",
    ar: "تحويل النقد إلى الخزنة أو البنك",
    fr: "Versement de la caisse au coffre ou à la banque",
  },
  {
    en: "Cash taken by the owner",
    ar: "نقد سحبه المالك",
    fr: "Espèces prélevées par le propriétaire",
  },
  {
    en: "Other (map an account first)",
    ar: "أخرى (اربط حساباً أولاً)",
    fr: "Autre (associez d’abord un compte)",
  },
  {
    en: "Retail shift #${input.shift.id} ${input.movement.movementType} · ${input.target.reasonCode}",
    ar: "وردية التجزئة #{{0}} {{1}} · {{2}}",
    fr: "Session de caisse de détail n° {{0}} {{1}} · {{2}}",
  },
  {
    en: "Retail shift #${input.shift.id} cash over/short ${variance.toFixed(2)}",
    ar: "وردية التجزئة #{{0}} فائض/عجز نقدي {{1}}",
    fr: "Session de caisse de détail n° {{0}} excédent/manque de caisse {{1}}",
  },
  {
    en: "Retail inventory opening at ${plan.openingDate}: stock ${plan.subLedgerValue}, ledger ${plan.ledgerBalance}",
    ar: "الرصيد الافتتاحي لمخزون التجزئة في {{0}}: المخزون {{1}}، الدفتر {{2}}",
    fr: "Ouverture du stock de détail au {{0}} : stock {{1}}, grand livre {{2}}",
  },
  {
    en: "Retail journal ${input.voucherNumber} does not balance",
    ar: "قيد التجزئة {{0}} غير متوازن",
    fr: "L’écriture de détail {{0}} n’est pas équilibrée",
  },
  {
    en: "Retail product stock · product ${input.referenceId} · variant ${input.variantId}",
    ar: "مخزون منتج التجزئة · المنتج {{0}} · المتغير {{1}}",
    fr: "Stock d’article de détail · article {{0}} · variante {{1}}",
  },
  {
    en: "Reclassification: Deferred Rent Revenue to Rental Income",
    ar: "إعادة تصنيف: من إيرادات الإيجار المؤجلة إلى إيرادات الإيجار",
    fr: "Reclassement : produits locatifs différés vers produits locatifs",
  },
  {
    en: "The deferred rent reclassification applies to Properties companies only.",
    ar: "تنطبق إعادة تصنيف الإيجار المؤجل على شركات العقارات فقط.",
    fr: "Le reclassement des loyers différés ne concerne que les sociétés immobilières.",
  },
  {
    en: "The Deferred Rent Revenue account has a balance but the company has no Rental Income account (RENT-INC).",
    ar: "يحمل حساب إيرادات الإيجار المؤجلة رصيدًا لكن الشركة لا تملك حساب إيرادات الإيجار (RENT-INC).",
    fr: "Le compte des produits locatifs différés a un solde mais la société n’a pas de compte de produits locatifs (RENT-INC).",
  },
  {
    en: "The reclassification date is in a closed fiscal period.",
    ar: "تاريخ إعادة التصنيف يقع في فترة مالية مقفلة.",
    fr: "La date du reclassement se situe dans une période fiscale clôturée.",
  },
  {
    en: "There is nothing to reclassify.",
    ar: "لا يوجد ما يُعاد تصنيفه.",
    fr: "Il n’y a rien à reclasser.",
  },
  {
    en: "The deferred rent reclassification changed since it was reviewed; review it again before applying.",
    ar: "تغيّرت إعادة تصنيف الإيجار المؤجل منذ مراجعتها؛ راجعها مرة أخرى قبل التطبيق.",
    fr: "Le reclassement des loyers différés a changé depuis sa revue ; revoyez-le avant de l’appliquer.",
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
  // Merge of main 365cf55: one-sided stock adjustment vouchers, Owner preview/apply.
  {
    en: "A supplier-partner company keeps its stock in sp_stock; its stock adjustments carry no Inventory line",
    ar: "تحتفظ شركة الشريك المورّد بمخزونها في sp_stock؛ ولا تحمل تسويات المخزون لديها سطر مخزون",
    fr: "Une société partenaire fournisseur tient son stock dans sp_stock ; ses ajustements de stock ne portent pas de ligne Stock",
  },
  {
    en: "The INVENTORY account is deleted, inactive, not an asset or still named as the credit-note expense; it is not renamed, retyped or restored here",
    ar: "حساب INVENTORY محذوف أو غير نشط أو ليس أصلاً أو ما زال يحمل اسم مصروف إشعار الدائن؛ لا تتم هنا إعادة تسميته أو تغيير نوعه أو استعادته",
    fr: "Le compte INVENTORY est supprimé, inactif, n’est pas un actif ou porte encore le nom de la charge d’avoir ; il n’est ni renommé, ni reclassé, ni restauré ici",
  },
  {
    en: "Voucher ${row.voucherNumber} would not balance; nothing was applied",
    ar: "لن يكون السند {{0}} متوازنًا؛ لم يُطبَّق أي شيء",
    fr: "La pièce {{0}} ne serait pas équilibrée ; rien n’a été appliqué",
  },
  {
    en: "Retail stock count ${session.code}",
    ar: "جرد مخزون التجزئة {{0}}",
    fr: "Inventaire du stock de détail {{0}}",
  },
];
