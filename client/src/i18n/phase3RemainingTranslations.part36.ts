import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

// Zambia ZMW multicurrency integration (Phases 1–8): the interface and server
// messages added for Kwacha rates, purchases, refunds and cash conversions.
// Merged right after part33 (parts 32–34 are the unified accounting screens).
export const phase3RemainingTranslationsPart36: readonly Phase3SharedUiEntry[] = [
  // Chat widget and AI purchase import
  {
    en: "A dated native Kwacha purchase is required.",
    ar: "يلزم إدخال عملية شراء بالكواشا مع تاريخ.",
    fr: "Un achat natif en kwacha daté est requis.",
  },
  {
    en: "An approved historical USD/ZMW rate is required for this purchase.",
    ar: "يلزم سعر صرف USD/ZMW تاريخي معتمد لهذه العملية.",
    fr: "Un taux USD/ZMW historique approuvé est requis pour cet achat.",
  },
  {
    en: "Could not verify the approved USD/ZMW rate.",
    ar: "تعذر التحقق من سعر USD/ZMW المعتمد.",
    fr: "Impossible de vérifier le taux USD/ZMW approuvé.",
  },
  { en: "USD — dollars", ar: "USD — دولار", fr: "USD — dollars" },
  { en: "ZMW — Kwacha (K)", ar: "ZMW — كواشا (K)", fr: "ZMW — Kwacha (K)" },
  {
    en: "Confirm whether this purchase is in USD or Kwacha (ZMW) before importing it for this company.",
    ar: "أكّد ما إذا كانت هذه العملية بالدولار (USD) أو بالكواشا (ZMW) قبل استيرادها لهذه الشركة.",
    fr: "Confirmez si cet achat est en USD ou en kwacha (ZMW) avant de l'importer pour cette société.",
  },
  // Daily rate modal and exchange-rate settings
  { en: "Business date unavailable", ar: "تاريخ العمل غير متاح", fr: "Date d'activité indisponible" },
  {
    en: "Company or business date is unavailable. Reload and try again.",
    ar: "الشركة أو تاريخ العمل غير متاح. أعد التحميل وحاول مرة أخرى.",
    fr: "La société ou la date d'activité est indisponible. Rechargez et réessayez.",
  },
  {
    en: "Reload before saving an exchange rate.",
    ar: "أعد التحميل قبل حفظ سعر الصرف.",
    fr: "Rechargez avant d'enregistrer un taux de change.",
  },
  {
    en: "Cannot load company business date",
    ar: "تعذر تحميل تاريخ عمل الشركة",
    fr: "Impossible de charger la date d'activité de la société",
  },
  { en: "Cannot save exchange rate", ar: "تعذر حفظ سعر الصرف", fr: "Impossible d'enregistrer le taux de change" },
  {
    en: "Company exchange-rate settings or business date are unavailable.",
    ar: "إعدادات سعر صرف الشركة أو تاريخ العمل غير متاحة.",
    fr: "Les paramètres de taux de change de la société ou la date d'activité sont indisponibles.",
  },
  { en: "Failed to load exchange rate", ar: "فشل تحميل سعر الصرف", fr: "Échec du chargement du taux de change" },
  {
    en: "Failed to load exchange rate history",
    ar: "فشل تحميل سجل أسعار الصرف",
    fr: "Échec du chargement de l'historique des taux de change",
  },
  {
    en: "Latest effective rate (as of the company business date)",
    ar: "آخر سعر ساري (حتى تاريخ عمل الشركة)",
    fr: "Dernier taux en vigueur (à la date d'activité de la société)",
  },
  {
    en: "Saved for the selected date. Historical vouchers are unchanged; current cash/bank translations update in reports.",
    ar: "تم الحفظ للتاريخ المحدد. السندات التاريخية لم تتغير؛ تتحدث ترجمات النقد/البنك الحالية في التقارير.",
    fr: "Enregistré pour la date sélectionnée. Les pièces historiques restent inchangées ; les conversions actuelles de caisse/banque sont mises à jour dans les rapports.",
  },
  {
    en: "The company business date is unavailable or your role cannot edit rates.",
    ar: "تاريخ عمل الشركة غير متاح أو أن دورك لا يسمح بتعديل الأسعار.",
    fr: "La date d'activité de la société est indisponible ou votre rôle ne peut pas modifier les taux.",
  },
  // Credit notes and refunds
  { en: "Inv. Cost (USD)", ar: "تكلفة المخزون (USD)", fr: "Coût stock (USD)" },
  { en: "Inv. Value (USD)", ar: "قيمة المخزون (USD)", fr: "Valeur stock (USD)" },
  {
    en: "Set an approved exchange rate for the refund date before saving.",
    ar: "حدد سعر صرف معتمدًا لتاريخ الاسترداد قبل الحفظ.",
    fr: "Définissez un taux de change approuvé pour la date du remboursement avant d'enregistrer.",
  },
  { en: "USD/ZMW rate required", ar: "سعر USD/ZMW مطلوب", fr: "Taux USD/ZMW requis" },
  {
    en: "No approved company/date USD/ZMW rate available",
    ar: "لا يوجد سعر USD/ZMW معتمد للشركة/التاريخ",
    fr: "Aucun taux USD/ZMW approuvé disponible pour la société et la date",
  },
  // Purchase-order import
  {
    en: "Applies to every line of this import. The spreadsheet must not state a different currency.",
    ar: "يسري على كل سطر في هذا الاستيراد. يجب ألا يحدد جدول البيانات عملة مختلفة.",
    fr: "S'applique à chaque ligne de cet import. La feuille de calcul ne doit pas indiquer une autre devise.",
  },
  {
    en: "Approve the USD/ZMW company rate for the import date before validating.",
    ar: "اعتمد سعر USD/ZMW للشركة لتاريخ الاستيراد قبل التحقق.",
    fr: "Approuvez le taux USD/ZMW de la société pour la date d'import avant de valider.",
  },
  {
    en: "Choose whether this purchase invoice is in USD or Kwacha (ZMW) before validating.",
    ar: "اختر ما إذا كانت فاتورة الشراء هذه بالدولار (USD) أو بالكواشا (ZMW) قبل التحقق.",
    fr: "Choisissez si cette facture d'achat est en USD ou en kwacha (ZMW) avant de valider.",
  },
  {
    en: "Historical USD/ZMW rate (ZMW per USD)",
    ar: "سعر USD/ZMW التاريخي (ZMW لكل USD)",
    fr: "Taux USD/ZMW historique (ZMW par USD)",
  },
  { en: "Historical rate required", ar: "السعر التاريخي مطلوب", fr: "Taux historique requis" },
  { en: "Invoice Currency *", ar: "عملة الفاتورة *", fr: "Devise de la facture *" },
  { en: "Invoice currency required", ar: "عملة الفاتورة مطلوبة", fr: "Devise de la facture requise" },
  {
    en: "USD — invoice prices in dollars",
    ar: "USD — أسعار الفاتورة بالدولار",
    fr: "USD — prix de la facture en dollars",
  },
  {
    en: "Unable to load the approved historical USD/ZMW rate",
    ar: "تعذر تحميل سعر USD/ZMW التاريخي المعتمد",
    fr: "Impossible de charger le taux USD/ZMW historique approuvé",
  },
  {
    en: "ZMW — invoice prices in Kwacha (K)",
    ar: "ZMW — أسعار الفاتورة بالكواشا (K)",
    fr: "ZMW — prix de la facture en kwacha (K)",
  },
  { en: "ZMW (locked)", ar: "ZMW (مقفل)", fr: "ZMW (verrouillé)" },
  // Vouchers and journals
  {
    en: "Approved USD/ZMW rate required",
    ar: "سعر USD/ZMW معتمد مطلوب",
    fr: "Taux USD/ZMW approuvé requis",
  },
  {
    en: "Enter a company exchange rate effective on the voucher date before posting.",
    ar: "أدخل سعر صرف للشركة ساريًا في تاريخ السند قبل الترحيل.",
    fr: "Saisissez un taux de change de la société en vigueur à la date de la pièce avant de comptabiliser.",
  },
  {
    en: "Approved historical USD/ZMW rate required",
    ar: "سعر USD/ZMW تاريخي معتمد مطلوب",
    fr: "Taux USD/ZMW historique approuvé requis",
  },
  {
    en: "A valid locked historical exchange rate is required for a foreign-currency voucher.",
    ar: "يلزم سعر صرف تاريخي مقفل صالح لسند بعملة أجنبية.",
    fr: "Un taux de change historique verrouillé valide est requis pour une pièce en devise étrangère.",
  },
  {
    en: "The historical ZMW voucher has no valid locked exchange rate.",
    ar: "سند ZMW التاريخي لا يحمل سعر صرف مقفلًا صالحًا.",
    fr: "La pièce ZMW historique n'a pas de taux de change verrouillé valide.",
  },
  { en: "ZMW — Kwacha", ar: "ZMW — كواشا", fr: "ZMW — Kwacha" },
  // Zambia cash/bank currency conversion
  {
    en: "Cannot fetch historical company rate",
    ar: "تعذر جلب سعر الشركة التاريخي",
    fr: "Impossible de récupérer le taux historique de la société",
  },
  {
    en: "Cannot load Zambia's business date",
    ar: "تعذر تحميل تاريخ عمل زامبيا",
    fr: "Impossible de charger la date d'activité de la Zambie",
  },
  { en: "Cash exchanged", ar: "تم صرف النقد", fr: "Espèces converties" },
  { en: "Destination cash/bank account", ar: "حساب النقد/البنك الوجهة", fr: "Compte caisse/banque de destination" },
  { en: "Funds arriving", ar: "الأموال الواردة", fr: "Fonds entrants" },
  { en: "Funds leaving", ar: "الأموال الصادرة", fr: "Fonds sortants" },
  { en: "Purpose (optional)", ar: "الغرض (اختياري)", fr: "Objet (facultatif)" },
  {
    en: "Resolve source account's historical currency amounts before transferring.",
    ar: "سوِّ مبالغ العملة التاريخية للحساب المصدر قبل التحويل.",
    fr: "Résolvez les montants historiques en devise du compte source avant de transférer.",
  },
  { en: "Source cash/bank account", ar: "حساب النقد/البنك المصدر", fr: "Compte caisse/banque source" },
  { en: "Source currency", ar: "عملة المصدر", fr: "Devise source" },
  { en: "Transfer date", ar: "تاريخ التحويل", fr: "Date du transfert" },
  {
    en: "Transfer details are not valid.",
    ar: "بيانات التحويل غير صالحة.",
    fr: "Les détails du transfert ne sont pas valides.",
  },
  { en: "Transfer not posted", ar: "لم يتم ترحيل التحويل", fr: "Transfert non comptabilisé" },
  {
    en: "Unable to load cash and bank balances",
    ar: "تعذر تحميل أرصدة النقد والبنك",
    fr: "Impossible de charger les soldes de caisse et de banque",
  },
  // POS checkout
  {
    en: "Check the exchange rate and item prices before saving.",
    ar: "تحقق من سعر الصرف وأسعار الأصناف قبل الحفظ.",
    fr: "Vérifiez le taux de change et les prix des articles avant d'enregistrer.",
  },
  {
    en: "Enter a positive unit price to two decimal places (ngwee).",
    ar: "أدخل سعر وحدة موجبًا بخانتين عشريتين (نغوي).",
    fr: "Saisissez un prix unitaire positif à deux décimales (ngwee).",
  },
  { en: "Invalid Kwacha price", ar: "سعر كواشا غير صالح", fr: "Prix en kwacha non valide" },
  { en: "Invalid foreign-currency price", ar: "سعر بعملة أجنبية غير صالح", fr: "Prix en devise étrangère non valide" },
  // Company settings
  { en: "ZMW — Zambian Kwacha (K)", ar: "ZMW — الكواشا الزامبية (K)", fr: "ZMW — Kwacha zambien (K)" },
  { en: "Africa/Lusaka — Zambia (UTC+2)", ar: "Africa/Lusaka — زامبيا (UTC+2)", fr: "Africa/Lusaka — Zambie (UTC+2)" },
  // Server messages: openings, refunds, rates, voucher edits, sales, purchases
  {
    en: "A Kwacha cash/bank opening must belong to a USD-base, ZMW-display company.",
    ar: "يجب أن يعود رصيد افتتاحي نقدي/بنكي بالكواشا إلى شركة أساسها USD وعرضها ZMW.",
    fr: "Un solde d'ouverture caisse/banque en kwacha doit appartenir à une société en base USD et affichage ZMW.",
  },
  {
    en: "Cannot change an existing refund's currency to ZMW.",
    ar: "لا يمكن تغيير عملة استرداد قائم إلى ZMW.",
    fr: "Impossible de changer la devise d'un remboursement existant en ZMW.",
  },
  {
    en: "Cannot change the original Kwacha refund currency or locked rate.",
    ar: "لا يمكن تغيير عملة الاسترداد الأصلية بالكواشا أو السعر المقفل.",
    fr: "Impossible de modifier la devise d'origine du remboursement en kwacha ou le taux verrouillé.",
  },
  {
    en: "Original ZMW refund has no locked exchange rate.",
    ar: "استرداد ZMW الأصلي لا يحمل سعر صرف مقفلًا.",
    fr: "Le remboursement ZMW d'origine n'a pas de taux de change verrouillé.",
  },
  {
    en: "Reverse and rebook to change the date of a Kwacha refund.",
    ar: "اعكس العملية وأعد تسجيلها لتغيير تاريخ استرداد بالكواشا.",
    fr: "Annulez et recomptabilisez pour changer la date d'un remboursement en kwacha.",
  },
  {
    en: "Both fromCurrency and toCurrency are required.",
    ar: "يلزم تحديد كل من fromCurrency و toCurrency.",
    fr: "Les paramètres fromCurrency et toCurrency sont tous deux requis.",
  },
  {
    en: "Cannot use a future-dated company rate for POS sales.",
    ar: "لا يمكن استخدام سعر شركة بتاريخ مستقبلي لمبيعات نقاط البيع.",
    fr: "Impossible d'utiliser un taux de société daté dans le futur pour les ventes POS.",
  },
  {
    en: "Exchange-rate pair does not match the active company's configured currencies.",
    ar: "زوج سعر الصرف لا يطابق العملات المضبوطة للشركة النشطة.",
    fr: "La paire de taux de change ne correspond pas aux devises configurées de la société active.",
  },
  {
    en: "Only the active company's configured currency pair can be updated.",
    ar: "يمكن تحديث زوج العملات المضبوط للشركة النشطة فقط.",
    fr: "Seule la paire de devises configurée de la société active peut être mise à jour.",
  },
  {
    en: "Rates are quoted against the company's accounting base currency; enable a display currency to use a fixed pair.",
    ar: "تُحدد الأسعار مقابل عملة الأساس المحاسبية للشركة؛ فعّل عملة عرض لاستخدام زوج ثابت.",
    fr: "Les taux sont cotés contre la devise comptable de base de la société ; activez une devise d'affichage pour utiliser une paire fixe.",
  },
  {
    en: "Switch to the requested company before accessing its exchange rates.",
    ar: "انتقل إلى الشركة المطلوبة قبل الوصول إلى أسعار صرفها.",
    fr: "Passez à la société demandée avant d'accéder à ses taux de change.",
  },
  {
    en: "The company's business date changed. Reload the daily rate prompt before saving.",
    ar: "تغيّر تاريخ عمل الشركة. أعد تحميل نافذة السعر اليومي قبل الحفظ.",
    fr: "La date d'activité de la société a changé. Rechargez l'invite du taux quotidien avant d'enregistrer.",
  },
  {
    en: "Use a valid YYYY-MM-DD asOf date.",
    ar: "استخدم تاريخ asOf صالحًا بصيغة YYYY-MM-DD.",
    fr: "Utilisez une date asOf valide au format YYYY-MM-DD.",
  },
  {
    en: "Kwacha historical openings require the active company to use USD/ZMW.",
    ar: "تتطلب الأرصدة الافتتاحية التاريخية بالكواشا أن تستخدم الشركة النشطة USD/ZMW.",
    fr: "Les soldes d'ouverture historiques en kwacha exigent que la société active utilise USD/ZMW.",
  },
  {
    en: "Historical Kwacha original amounts must be resolved before editing.",
    ar: "يجب تسوية المبالغ الأصلية التاريخية بالكواشا قبل التعديل.",
    fr: "Les montants d'origine historiques en kwacha doivent être résolus avant la modification.",
  },
  {
    en: "Posted Kwacha entry currency is immutable. Reverse and rebook to change it.",
    ar: "عملة قيد الكواشا المرحّل ثابتة. اعكس القيد وأعد تسجيله لتغييرها.",
    fr: "La devise d'une écriture en kwacha comptabilisée est immuable. Annulez et recomptabilisez pour la changer.",
  },
  {
    en: "The original Kwacha exchange rate is missing or cannot be changed.",
    ar: "سعر صرف الكواشا الأصلي مفقود أو لا يمكن تغييره.",
    fr: "Le taux de change d'origine en kwacha est manquant ou ne peut pas être modifié.",
  },
  {
    en: "ZMW voucher base/transaction amount conflict; reload the original currency amounts.",
    ar: "تعارض بين مبلغ الأساس ومبلغ المعاملة في سند ZMW؛ أعد تحميل مبالغ العملة الأصلية.",
    fr: "Conflit entre le montant de base et le montant de transaction de la pièce ZMW ; rechargez les montants en devise d'origine.",
  },
  {
    en: "ZMW voucher entry currency must match its original voucher currency.",
    ar: "يجب أن تطابق عملة قيد سند ZMW عملة السند الأصلية.",
    fr: "La devise d'une écriture de pièce ZMW doit correspondre à la devise d'origine de la pièce.",
  },
  {
    en: "Posted transaction debit and credit amounts must be finite",
    ar: "يجب أن تكون مبالغ المدين والدائن المرحّلة أرقامًا محدودة",
    fr: "Les montants débit et crédit comptabilisés doivent être des nombres finis",
  },
  {
    en: "baseAmount must be finite",
    ar: "يجب أن يكون baseAmount رقمًا محدودًا",
    fr: "baseAmount doit être un nombre fini",
  },
  {
    en: "transactionAmount must be finite",
    ar: "يجب أن يكون transactionAmount رقمًا محدودًا",
    fr: "transactionAmount doit être un nombre fini",
  },
  { en: "bad quantity", ar: "كمية غير صالحة", fr: "quantité non valide" },
  { en: "more than 2 decimal places", ar: "أكثر من خانتين عشريتين", fr: "plus de 2 décimales" },
  { en: "negative or nonfinite", ar: "سالب أو غير محدود", fr: "négatif ou non fini" },
  {
    en: "Reverse and rebook a Kwacha sale to change its date and rate.",
    ar: "اعكس عملية بيع بالكواشا وأعد تسجيلها لتغيير تاريخها وسعرها.",
    fr: "Annulez et recomptabilisez une vente en kwacha pour changer sa date et son taux.",
  },
  {
    en: "The original ZMW sale currency cannot be changed during an edit.",
    ar: "لا يمكن تغيير عملة البيع الأصلية ZMW أثناء التعديل.",
    fr: "La devise d'origine ZMW de la vente ne peut pas être modifiée lors d'une édition.",
  },
  {
    en: "Native PO line values do not reconcile to stored historic USD costs",
    ar: "قيم سطور أمر الشراء بالعملة الأصلية لا تتطابق مع التكاليف التاريخية المخزنة بالدولار",
    fr: "Les valeurs natives des lignes du bon de commande ne concordent pas avec les coûts historiques USD enregistrés",
  },
  {
    en: "Native purchase line set is incomplete",
    ar: "مجموعة سطور الشراء بالعملة الأصلية غير مكتملة",
    fr: "L'ensemble des lignes d'achat natives est incomplet",
  },
  {
    en: "Rate must be greater than zero.",
    ar: "يجب أن يكون السعر أكبر من صفر.",
    fr: "Le taux doit être supérieur à zéro.",
  },
];
