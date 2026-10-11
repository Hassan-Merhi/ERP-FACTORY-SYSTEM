import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

// Accounting audit phase 23 (chart of accounts and general ledger model).
export const wave8ReleaseTranslationsPhase23: readonly Phase3SharedUiEntry[] = [
  // Opening journal (services/accounting/openingJournal.ts).
  {
    en: "A cut-over date (YYYY-MM-DD) is required.",
    ar: "يلزم تاريخ تحويل (YYYY-MM-DD).",
    fr: "Une date de bascule (AAAA-MM-JJ) est requise.",
  },
  {
    en: "The opening journal of this company has already been applied.",
    ar: "تم تطبيق القيد الافتتاحي لهذه الشركة بالفعل.",
    fr: "L’écriture d’ouverture de cette société a déjà été appliquée.",
  },
  {
    en: "The company has a closed fiscal period; its openings are frozen. Reopen it first.",
    ar: "لدى الشركة فترة مالية مغلقة؛ أرصدتها الافتتاحية مجمّدة. أعد فتحها أولاً.",
    fr: "La société a un exercice clôturé ; ses soldes d’ouverture sont figés. Rouvrez-le d’abord.",
  },
  {
    en: "The company's base currency is not USD; the opening journal is posted in USD only.",
    ar: "العملة الأساسية للشركة ليست الدولار الأمريكي؛ يُرحَّل القيد الافتتاحي بالدولار الأمريكي فقط.",
    fr: "La devise de base de la société n’est pas l’USD ; l’écriture d’ouverture est passée en USD uniquement.",
  },
  {
    en: "OPENING_BALANCE_EQUITY or RETAINED_EARNINGS is deleted or missing.",
    ar: "حساب OPENING_BALANCE_EQUITY أو RETAINED_EARNINGS محذوف أو غير موجود.",
    fr: "OPENING_BALANCE_EQUITY ou RETAINED_EARNINGS est supprimé ou absent.",
  },
  {
    en: "The company has no opening balance to move into a journal.",
    ar: "لا يوجد لدى الشركة رصيد افتتاحي لنقله إلى قيد.",
    fr: "La société n’a aucun solde d’ouverture à transférer dans une écriture.",
  },
  {
    en: "The openings changed since they were reviewed; review the plan again.",
    ar: "تغيّرت الأرصدة الافتتاحية منذ مراجعتها؛ راجع الخطة مرة أخرى.",
    fr: "Les soldes d’ouverture ont changé depuis leur revue ; revoyez le plan.",
  },
  {
    en: "A cut-over date is required",
    ar: "يلزم تاريخ تحويل",
    fr: "Une date de bascule est requise",
  },
  {
    en: "OPENING_JOURNAL_APPLIED: the opening balances were moved into the opening journal of ${date}, so an opening balance cannot be created, changed or deleted",
    ar: "OPENING_JOURNAL_APPLIED: نُقلت الأرصدة الافتتاحية إلى القيد الافتتاحي بتاريخ {{0}}، لذلك لا يمكن إنشاء رصيد افتتاحي أو تغييره أو حذفه",
    fr: "OPENING_JOURNAL_APPLIED : les soldes d’ouverture ont été transférés dans l’écriture d’ouverture du {{0}} ; un solde d’ouverture ne peut donc être ni créé, ni modifié, ni supprimé",
  },
  // Legacy line reclassification (services/accounting/legacyLineRepair.ts).
  {
    en: "There is no legacy line to repair in this company.",
    ar: "لا توجد سطور قديمة لإصلاحها في هذه الشركة.",
    fr: "Il n’y a aucune ligne ancienne à corriger dans cette société.",
  },
  {
    en: "The destination must be a live, active leaf ledger account of this company.",
    ar: "يجب أن تكون الوجهة حساب أستاذ فرعياً نشطاً وغير محذوف في هذه الشركة.",
    fr: "La destination doit être un compte de grand livre de détail, actif et non supprimé, de cette société.",
  },
  {
    en: "The legacy lines changed since they were reviewed; review the plan again.",
    ar: "تغيّرت السطور القديمة منذ مراجعتها؛ راجع الخطة مرة أخرى.",
    fr: "Les lignes anciennes ont changé depuis leur revue ; revoyez le plan.",
  },
  // Account reclassification (services/accounting/accountReclassification.ts).
  {
    en: "A reclassification date (YYYY-MM-DD) is required.",
    ar: "يلزم تاريخ إعادة التصنيف (YYYY-MM-DD).",
    fr: "Une date de reclassement (AAAA-MM-JJ) est requise.",
  },
  {
    en: "Choose between 1 and 200 source accounts.",
    ar: "اختر ما بين 1 و200 حساب مصدر.",
    fr: "Choisissez entre 1 et 200 comptes source.",
  },
  {
    en: "A source account is not a live leaf ledger account of this company.",
    ar: "أحد الحسابات المصدر ليس حساب أستاذ فرعياً نشطاً في هذه الشركة.",
    fr: "Un compte source n’est pas un compte de grand livre de détail actif de cette société.",
  },
  {
    en: "The destination must be a live, active leaf ledger account of this company, not a source.",
    ar: "يجب أن تكون الوجهة حساب أستاذ فرعياً نشطاً وغير محذوف في هذه الشركة، وليست أحد الحسابات المصدر.",
    fr: "La destination doit être un compte de grand livre de détail, actif et non supprimé, de cette société, et non un compte source.",
  },
  {
    en: "A customer's linked ledger account is the customer's sub-ledger and cannot be reclassified.",
    ar: "حساب الأستاذ المرتبط بالعميل هو دفتره الفرعي ولا يمكن إعادة تصنيفه.",
    fr: "Le compte de grand livre lié à un client est son sous-registre et ne peut pas être reclassé.",
  },
  {
    en: "The source accounts have no balance on that date.",
    ar: "لا يوجد رصيد للحسابات المصدر في ذلك التاريخ.",
    fr: "Les comptes source n’ont aucun solde à cette date.",
  },
  {
    en: "The balances changed since they were reviewed; review the plan again.",
    ar: "تغيّرت الأرصدة منذ مراجعتها؛ راجع الخطة مرة أخرى.",
    fr: "Les soldes ont changé depuis leur revue ; revoyez le plan.",
  },
  {
    en: "Account migration no longer moves vouchers between companies or rewrites their lines. Move an account's balance with an account reclassification journal (Owner), or between companies with an intercompany transfer.",
    ar: "لم يعد ترحيل الحسابات ينقل السندات بين الشركات أو يعيد كتابة سطورها. انقل رصيد الحساب بقيد إعادة تصنيف (المالك)، أو بين الشركات بتحويل بين الشركات.",
    fr: "La migration de comptes ne déplace plus les bons entre sociétés et ne réécrit plus leurs lignes. Transférez le solde d’un compte par une écriture de reclassement (propriétaire), ou entre sociétés par un transfert intersociétés.",
  },
  // Functional currency (services/accounting/functionalCurrency.ts).
  {
    en: "The company has posted vouchers, so its base (functional) currency cannot be changed. Change the display currency instead.",
    ar: "لدى الشركة سندات مرحّلة، لذلك لا يمكن تغيير عملتها الأساسية (الوظيفية). غيّر عملة العرض بدلاً من ذلك.",
    fr: "La société a des bons comptabilisés ; sa devise de base (fonctionnelle) ne peut donc pas être modifiée. Changez plutôt la devise d’affichage.",
  },
  // Fiscal close (storage/accounting/fiscal-periods.ts, routes/financialSalesRoutes.ts).
  {
    en: "Period start date and end date are required",
    ar: "تاريخا بداية الفترة ونهايتها مطلوبان",
    fr: "Les dates de début et de fin de période sont requises",
  },
  {
    en: "The company has no RETAINED_EARNINGS system account",
    ar: "لا يوجد لدى الشركة حساب النظام RETAINED_EARNINGS",
    fr: "La société n’a pas de compte système RETAINED_EARNINGS",
  },
  {
    en: "The retained earnings account must be the company's RETAINED_EARNINGS system account",
    ar: "يجب أن يكون حساب الأرباح المحتجزة هو حساب النظام RETAINED_EARNINGS للشركة",
    fr: "Le compte de résultats non distribués doit être le compte système RETAINED_EARNINGS de la société",
  },
  {
    en: "The retained earnings account must be the company's RETAINED_EARNINGS system account.",
    ar: "يجب أن يكون حساب الأرباح المحتجزة هو حساب النظام RETAINED_EARNINGS للشركة.",
    fr: "Le compte de résultats non distribués doit être le compte système RETAINED_EARNINGS de la société.",
  },
  {
    en: "The company has no RETAINED_EARNINGS system account; it is created at the next start, or by the chart of accounts template.",
    ar: "لا يوجد لدى الشركة حساب النظام RETAINED_EARNINGS؛ يُنشأ عند التشغيل التالي أو بواسطة نموذج دليل الحسابات.",
    fr: "La société n’a pas de compte système RETAINED_EARNINGS ; il est créé au prochain démarrage, ou par le modèle de plan comptable.",
  },
  {
    en: "Only Admins and Owners can reopen fiscal periods",
    ar: "يمكن للمسؤولين والمالكين فقط إعادة فتح الفترات المالية",
    fr: "Seuls les administrateurs et les propriétaires peuvent rouvrir des exercices",
  },
  {
    en: "Accounts of an unknown type carry a balance at ${periodEndDate}: ${list}. Give them a known account type before closing.",
    ar: "توجد حسابات من نوع غير معروف تحمل رصيداً في {{0}}: {{1}}. حدّد لها نوع حساب معروفاً قبل الإغلاق.",
    fr: "Des comptes de type inconnu ont un solde au {{0}} : {{1}}. Donnez-leur un type de compte connu avant la clôture.",
  },
  {
    en: "The trial balance at ${periodEndDate} does not balance (difference ${difference}: openings ${openings}, one-sided stock vouchers ${stock}, other unbalanced vouchers ${other}). Correct it before closing.",
    ar: "ميزان المراجعة في {{0}} غير متوازن (الفرق {{1}}: الأرصدة الافتتاحية {{2}}، سندات المخزون أحادية الطرف {{3}}، سندات أخرى غير متوازنة {{4}}). صحّحه قبل الإغلاق.",
    fr: "La balance au {{0}} n’est pas équilibrée (écart {{1}} : soldes d’ouverture {{2}}, bons de stock unilatéraux {{3}}, autres bons déséquilibrés {{4}}). Corrigez-la avant la clôture.",
  },
  // Period general ledger (routes/accounting-integrity/ledgerModelRoutes.ts).
  {
    en: "from and to (YYYY-MM-DD, from <= to) are required",
    ar: "يلزم from وto (YYYY-MM-DD، وfrom <= to)",
    fr: "from et to (AAAA-MM-JJ, from <= to) sont requis",
  },
  {
    en: "Unknown account kind",
    ar: "نوع حساب غير معروف",
    fr: "Type de compte inconnu",
  },
  // Ledger guard v5 and currency trigger v3 (database messages).
  {
    en: "LEDGER_ACCOUNT_INACTIVE: ledger account ${id} is inactive and cannot be posted to",
    ar: "LEDGER_ACCOUNT_INACTIVE: حساب الأستاذ {{0}} غير نشط ولا يمكن الترحيل إليه",
    fr: "LEDGER_ACCOUNT_INACTIVE : le compte de grand livre {{0}} est inactif et ne peut pas être mouvementé",
  },
  {
    en: "LEDGER_ACCOUNT_NOT_LEAF: ledger account ${id} is a group account (it has sub-accounts) and cannot be posted to",
    ar: "LEDGER_ACCOUNT_NOT_LEAF: حساب الأستاذ {{0}} حساب تجميعي (له حسابات فرعية) ولا يمكن الترحيل إليه",
    fr: "LEDGER_ACCOUNT_NOT_LEAF : le compte de grand livre {{0}} est un compte de regroupement (il a des sous-comptes) et ne peut pas être mouvementé",
  },
  {
    en: "BANK_ACCOUNT_INACTIVE: bank account ${id} is inactive and cannot be posted to",
    ar: "BANK_ACCOUNT_INACTIVE: الحساب البنكي {{0}} غير نشط ولا يمكن الترحيل إليه",
    fr: "BANK_ACCOUNT_INACTIVE : le compte bancaire {{0}} est inactif et ne peut pas être mouvementé",
  },
  {
    en: "PARTY_DELETED: ${party} ${id} is deleted and cannot be posted to",
    ar: "PARTY_DELETED: {{0}} {{1}} محذوف ولا يمكن الترحيل إليه",
    fr: "PARTY_DELETED : {{0}} {{1}} est supprimé et ne peut pas être mouvementé",
  },
  {
    en: "SUPPLIER_COMPANY_MISMATCH: supplier ${supplierId} does not belong to company ${companyId}",
    ar: "SUPPLIER_COMPANY_MISMATCH: المورد {{0}} لا يتبع الشركة {{1}}",
    fr: "SUPPLIER_COMPANY_MISMATCH : le fournisseur {{0}} n’appartient pas à la société {{1}}",
  },
  {
    en: "VOUCHER_LINE_CURRENCY_MISMATCH: a ${lineCurrency} line cannot be posted on a ${voucherCurrency} voucher (voucher ${voucherId})",
    ar: "VOUCHER_LINE_CURRENCY_MISMATCH: لا يمكن ترحيل سطر بعملة {{0}} على سند بعملة {{1}} (السند {{2}})",
    fr: "VOUCHER_LINE_CURRENCY_MISMATCH : une ligne en {{0}} ne peut pas être passée sur un bon en {{1}} (bon {{2}})",
  },
  {
    en: "VOUCHER_LINE_RATE_MISMATCH: the ${currency} rate ${rate} of voucher ${voucherId} differs from the recorded rate ${recorded} on ${date}",
    ar: "VOUCHER_LINE_RATE_MISMATCH: سعر {{0}} البالغ {{1}} في السند {{2}} يختلف عن السعر المسجل {{3}} بتاريخ {{4}}",
    fr: "VOUCHER_LINE_RATE_MISMATCH : le taux {{0}} de {{1}} du bon {{2}} diffère du taux enregistré {{3}} au {{4}}",
  },
  {
    en: "Reclassification of legacy lines on missing, deleted or other-company accounts",
    ar: "إعادة تصنيف السطور القديمة على حسابات مفقودة أو محذوفة أو تابعة لشركة أخرى",
    fr: "Reclassement des lignes anciennes sur des comptes manquants, supprimés ou d’une autre société",
  },
  {
    en: "constraint missing",
    ar: "القيد غير موجود",
    fr: "contrainte absente",
  },
  {
    en: "Account reclassification: ${sourceCodes} to ${destinationCode}",
    ar: "إعادة تصنيف الحساب: {{0}} إلى {{1}}",
    fr: "Reclassement de compte : {{0}} vers {{1}}",
  },
  {
    en: "Opening balances at ${plan.cutOverDate}",
    ar: "الأرصدة الافتتاحية في {{0}}",
    fr: "Soldes d’ouverture au {{0}}",
  },
];
