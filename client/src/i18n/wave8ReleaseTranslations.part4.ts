import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

// Wave 8 release closeout, continued from part 3 (which reached the 900-line limit).
export const wave8ReleaseTranslationsPart4: readonly Phase3SharedUiEntry[] = [
  {
    en: "txDate must be a YYYY-MM-DD date",
    ar: "يجب أن يكون txDate تاريخاً بصيغة YYYY-MM-DD",
    fr: "txDate doit être une date au format AAAA-MM-JJ",
  },
  {
    en: "ids must be bale ids",
    ar: "يجب أن تكون المعرّفات معرّفات بالات",
    fr: "les identifiants doivent être des identifiants de balles",
  },
  // Phase 22 A: correction policy, engine rounding and numbering.
  {
    en: "Voucher number counter could not be created",
    ar: "تعذر إنشاء عدّاد أرقام السندات",
    fr: "Le compteur de numéros de bons n’a pas pu être créé",
  },
  {
    en: "voucherNumber is required before a voucher can be inserted",
    ar: "يلزم voucherNumber قبل إدراج السند",
    fr: "voucherNumber est requis avant d’insérer un bon",
  },
  {
    en: "This voucher is deleted and cannot be changed or reversed.",
    ar: "هذا السند محذوف ولا يمكن تعديله أو عكسه.",
    fr: "Ce bon est supprimé et ne peut être ni modifié ni extourné.",
  },
  {
    en: "This voucher is dated in a closed period and cannot be edited. Reverse it and post a corrected voucher dated in an open period instead.",
    ar: "هذا السند مؤرخ في فترة مقفلة ولا يمكن تعديله. اعكسه ثم سجّل سنداً مصححاً بتاريخ في فترة مفتوحة.",
    fr: "Ce bon est daté dans une période clôturée et ne peut pas être modifié. Extournez-le et passez un bon corrigé daté dans une période ouverte.",
  },
  {
    en: "This voucher has been reversed, or is itself a reversal, and cannot be edited. Post a new voucher instead.",
    ar: "تم عكس هذا السند، أو أنه هو نفسه سند عكس، ولا يمكن تعديله. سجّل سنداً جديداً بدلاً من ذلك.",
    fr: "Ce bon a été extourné, ou est lui-même une extourne, et ne peut pas être modifié. Passez plutôt un nouveau bon.",
  },
  {
    en: "A reason is required to reverse a voucher.",
    ar: "يلزم ذكر سبب لعكس السند.",
    fr: "Un motif est requis pour extourner un bon.",
  },
  {
    en: "This voucher has already been reversed.",
    ar: "تم عكس هذا السند بالفعل.",
    fr: "Ce bon a déjà été extourné.",
  },
  {
    en: "A reversal voucher cannot itself be reversed.",
    ar: "لا يمكن عكس سند العكس نفسه.",
    fr: "Un bon d’extourne ne peut pas lui-même être extourné.",
  },
  {
    en: "An optional voucher is not posted to the ledger, so there is nothing to reverse.",
    ar: "السند الاختياري غير مرحّل إلى الدفتر، لذلك لا يوجد ما يُعكس.",
    fr: "Un bon facultatif n’est pas comptabilisé au grand livre : il n’y a rien à extourner.",
  },
  {
    en: "The reversal date is in a closed period. Choose a date in an open period.",
    ar: "تاريخ العكس في فترة مقفلة. اختر تاريخاً في فترة مفتوحة.",
    fr: "La date d’extourne est dans une période clôturée. Choisissez une date dans une période ouverte.",
  },
  {
    en: "The reversal date must be a YYYY-MM-DD date.",
    ar: "يجب أن يكون تاريخ العكس بصيغة YYYY-MM-DD.",
    fr: "La date d’extourne doit être au format AAAA-MM-JJ.",
  },
  {
    en: "Voucher is not balanced in its transaction currency",
    ar: "السند غير متوازن بعملة المعاملة",
    fr: "Le bon n’est pas équilibré dans sa devise de transaction",
  },
  {
    en: "The company's ROUNDING account is deleted; restore it before posting a voucher with a rounding difference",
    ar: "حساب ROUNDING الخاص بالشركة محذوف؛ استعده قبل ترحيل سند فيه فرق تقريب",
    fr: "Le compte ROUNDING de la société est supprimé ; restaurez-le avant de passer un bon comportant un écart d’arrondi",
  },
  {
    en: "The company's ROUNDING account could not be provisioned",
    ar: "تعذر إنشاء حساب ROUNDING الخاص بالشركة",
    fr: "Le compte ROUNDING de la société n’a pas pu être créé",
  },
  {
    en: "A valid companyId is required to number a voucher",
    ar: "يلزم companyId صالح لترقيم السند",
    fr: "Un companyId valide est requis pour numéroter un bon",
  },
  {
    en: "A voucher date (YYYY-MM-DD) is required to number a voucher",
    ar: "يلزم تاريخ السند (YYYY-MM-DD) لترقيمه",
    fr: "Une date de bon (AAAA-MM-JJ) est requise pour le numéroter",
  },
  {
    en: "A voucher type is required to number a voucher",
    ar: "يلزم نوع السند لترقيمه",
    fr: "Un type de bon est requis pour le numéroter",
  },
  {
    en: "Rounding Differences",
    ar: "فروق التقريب",
    fr: "Écarts d’arrondi",
  },
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
  // Wave 18 A: rental "post due accruals now" (the units page no longer posts on load).
  {
    en: "Post due accruals now",
    ar: "ترحيل الاستحقاقات المستحقة الآن",
    fr: "Comptabiliser maintenant les loyers échus",
  },
  {
    en: "Due rent posted",
    ar: "تم ترحيل الإيجار المستحق",
    fr: "Loyers échus comptabilisés",
  },
  {
    en: "Rows accrued: ${result.accrued}; scheduled payments posted: ${result.scheduledPaymentsPosted}; skipped (closed period): ${result.skipped.length}",
    ar: "الأشهر المستحقة: {{0}}؛ الدفعات المجدولة المرحّلة: {{1}}؛ المتخطاة (فترة مقفلة): {{2}}",
    fr: "Mois comptabilisés : {{0}} ; paiements planifiés comptabilisés : {{1}} ; ignorés (période clôturée) : {{2}}",
  },
  {
    en: "Could not post due accruals",
    ar: "تعذر ترحيل الاستحقاقات المستحقة",
    fr: "Impossible de comptabiliser les loyers échus",
  },
  // Wave 18 A: legacy prepaid shop rent recognition (Owner preview/apply).
  {
    en: "The legacy prepaid rent recognition applies to the ERP and factory shop rentals only.",
    ar: "ينطبق الاعتراف بالإيجار المدفوع مقدمًا القديم على إيجارات محلات ERP والمصنع فقط.",
    fr: "La comptabilisation des anciens loyers payés d’avance ne concerne que les locations de boutiques ERP et usine.",
  },
  {
    en: "There is no legacy prepaid rent month to recognise.",
    ar: "لا يوجد شهر إيجار مدفوع مقدمًا قديم للاعتراف به.",
    fr: "Aucun ancien mois de loyer payé d’avance n’est à comptabiliser.",
  },
  {
    en: "The legacy prepaid rent recognition changed since it was reviewed; review it again before applying.",
    ar: "تغيّر الاعتراف بالإيجار المدفوع مقدمًا القديم منذ مراجعته؛ راجعه مرة أخرى قبل التطبيق.",
    fr: "La comptabilisation des anciens loyers payés d’avance a changé depuis sa revue ; revoyez-la avant de l’appliquer.",
  },
  {
    en: "Perpetual inventory applies from ${effectiveFrom}: stock cannot be imported from a spreadsheet. Enter it through costed receipts and mixes.",
    ar: "يُطبَّق الجرد الدائم اعتبارًا من {{0}}: لا يمكن استيراد المخزون من جدول بيانات. أدخله عبر إيصالات وخلطات ذات تكلفة.",
    fr: "L’inventaire permanent s’applique à partir du {{0}} : le stock ne peut pas être importé d’un tableur. Saisissez-le par des réceptions et des mélanges valorisés.",
  },
  {
    en: "Perpetual inventory applies from ${effectiveFrom}: a stock entry cannot be dated before it.",
    ar: "يُطبَّق الجرد الدائم اعتبارًا من {{0}}: لا يمكن تأريخ إدخال مخزون قبل هذا التاريخ.",
    fr: "L’inventaire permanent s’applique à partir du {{0}} : une entrée de stock ne peut pas être datée avant cette date.",
  },
  {
    en: "kind must be customer, supplier or factorySupplier",
    ar: "يجب أن يكون النوع customer أو supplier أو factorySupplier",
    fr: "kind doit être customer, supplier ou factorySupplier",
  },
  {
    en: 'Ledger account "${name}" could not be found or created',
    ar: 'تعذر العثور على حساب الأستاذ "{{0}}" أو إنشاؤه',
    fr: "Le compte du grand livre « {{0}} » est introuvable et n’a pas pu être créé",
  },
  {
    en: "The request company does not match the active company.",
    ar: "شركة الطلب لا تطابق الشركة النشطة.",
    fr: "La société de la requête ne correspond pas à la société active.",
  },
  {
    en: "Only an Admin or Owner can change an opening balance that is not zero.",
    ar: "يمكن للمسؤول أو المالك فقط تغيير رصيد افتتاحي غير صفري.",
    fr: "Seul un administrateur ou le propriétaire peut modifier un solde d’ouverture non nul.",
  },
  {
    en: "This bank account or its linked ledger already has voucher entries, so the linked ledger cannot be changed.",
    ar: "يحتوي هذا الحساب البنكي أو حساب دفتر الأستاذ المرتبط به على قيود سندات بالفعل، لذلك لا يمكن تغيير الحساب المرتبط.",
    fr: "Ce compte bancaire ou son compte général lié a déjà des écritures, le compte lié ne peut donc pas être modifié.",
  },
  {
    en: "Cannot delete bank account: it has a non-zero opening balance. Move the balance with a journal entry first, or deactivate it instead.",
    ar: "لا يمكن حذف الحساب البنكي: لديه رصيد افتتاحي غير صفري. انقل الرصيد بقيد يومية أولاً، أو قم بتعطيله بدلاً من ذلك.",
    fr: "Impossible de supprimer le compte bancaire : il a un solde d’ouverture non nul. Transférez d’abord le solde par une écriture de journal, ou désactivez-le.",
  },
  {
    en: "An account is deleted with the delete action, not by editing it.",
    ar: "يُحذف الحساب بإجراء الحذف، وليس بتعديله.",
    fr: "Un compte se supprime avec l’action de suppression, pas en le modifiant.",
  },
  {
    en: "Only an Admin or Owner can change an account's code or active status.",
    ar: "يمكن للمسؤول أو المالك فقط تغيير رمز الحساب أو حالة تفعيله.",
    fr: "Seul un administrateur ou le propriétaire peut modifier le code ou le statut actif d’un compte.",
  },
  {
    en: "The system finds an account by this code, so an account cannot be re-coded to it or away from it.",
    ar: "يعثر النظام على حساب بهذا الرمز، لذلك لا يمكن تغيير رمز حساب إليه أو منه.",
    fr: "Le système retrouve un compte par ce code ; un compte ne peut donc pas recevoir ce code ni le perdre.",
  },
  {
    en: "This account is named on voucher lines or has an opening balance, so it cannot be permanently deleted. Keep it in Deleted Items.",
    ar: "هذا الحساب مذكور في بنود سندات أو لديه رصيد افتتاحي، لذلك لا يمكن حذفه نهائياً. أبقه في العناصر المحذوفة.",
    fr: "Ce compte figure sur des lignes de pièces ou a un solde d’ouverture ; il ne peut donc pas être supprimé définitivement. Gardez-le dans les éléments supprimés.",
  },
  {
    en: "This customer has an opening balance, so it cannot be permanently deleted. Keep it in Deleted Items.",
    ar: "لدى هذا العميل رصيد افتتاحي، لذلك لا يمكن حذفه نهائياً. أبقه في العناصر المحذوفة.",
    fr: "Ce client a un solde d’ouverture ; il ne peut donc pas être supprimé définitivement. Gardez-le dans les éléments supprimés.",
  },
  {
    en: "This voucher was retired by the system when its posting was replaced, so it is kept as history and cannot be permanently deleted.",
    ar: "أوقف النظام هذا السند عند استبدال ترحيله، لذلك يُحتفظ به كسجل تاريخي ولا يمكن حذفه نهائياً.",
    fr: "Cette pièce a été retirée par le système lors du remplacement de sa comptabilisation ; elle est conservée comme historique et ne peut pas être supprimée définitivement.",
  },
  {
    en: "The account with code INVENTORY is not an asset account, so it cannot be used as the inventory control account. Correct it in the chart of accounts first (see the accounting integrity diagnostic).",
    ar: "الحساب ذو الرمز INVENTORY ليس حساب أصول، لذلك لا يمكن استخدامه كحساب مراقبة المخزون. صححه في دليل الحسابات أولاً (راجع تشخيص سلامة المحاسبة).",
    fr: "Le compte de code INVENTORY n’est pas un compte d’actif ; il ne peut donc pas servir de compte de contrôle des stocks. Corrigez-le d’abord dans le plan comptable (voir le diagnostic d’intégrité comptable).",
  },
  {
    en: "The account with code INVENTORY is deleted, so it cannot be used as the inventory control account. Review it in the accounting integrity diagnostic first.",
    ar: "الحساب ذو الرمز INVENTORY محذوف، لذلك لا يمكن استخدامه كحساب مراقبة المخزون. راجعه في تشخيص سلامة المحاسبة أولاً.",
    fr: "Le compte de code INVENTORY est supprimé ; il ne peut donc pas servir de compte de contrôle des stocks. Examinez-le d’abord dans le diagnostic d’intégrité comptable.",
  },
  {
    en: "There is no account with code INVENTORY and another account already uses the name Inventory, so the inventory control account cannot be created. Review it in the accounting integrity diagnostic first.",
    ar: "لا يوجد حساب بالرمز INVENTORY وحساب آخر يستخدم الاسم Inventory بالفعل، لذلك لا يمكن إنشاء حساب مراقبة المخزون. راجعه في تشخيص سلامة المحاسبة أولاً.",
    fr: "Il n’existe aucun compte de code INVENTORY et un autre compte porte déjà le nom Inventory ; le compte de contrôle des stocks ne peut donc pas être créé. Examinez-le d’abord dans le diagnostic d’intégrité comptable.",
  },
  {
    en: "The intercompany counterpart voucher has lines in more than one currency or rate, so this edit cannot rescale it. Delete the journal and post the transfer again instead.",
    ar: "يحتوي السند المقابل بين الشركات على بنود بأكثر من عملة أو سعر، لذلك لا يمكن لهذا التعديل إعادة قياسه. احذف القيد وأعد ترحيل التحويل بدلاً من ذلك.",
    fr: "La pièce de contrepartie intersociétés a des lignes en plusieurs devises ou taux ; cette modification ne peut donc pas la remettre à l’échelle. Supprimez l’écriture et comptabilisez de nouveau le transfert.",
  },
  {
    en: "The journal had a zero total, so its intercompany counterpart cannot be rescaled. Delete the journal and post the transfer again instead.",
    ar: "كان إجمالي القيد صفراً، لذلك لا يمكن إعادة قياس مقابله بين الشركات. احذف القيد وأعد ترحيل التحويل بدلاً من ذلك.",
    fr: "L’écriture avait un total nul ; sa contrepartie intersociétés ne peut donc pas être remise à l’échelle. Supprimez l’écriture et comptabilisez de nouveau le transfert.",
  },
  {
    en: "These vouchers are in a closed period (closed through ${outcome.closedThrough}), so their location cannot be changed: ${closedVouchers}",
    ar: "هذه السندات في فترة مقفلة (مقفلة حتى {{0}})، لذلك لا يمكن تغيير موقعها: {{1}}",
    fr: "Ces pièces sont dans une période clôturée (clôturée jusqu’au {{0}}) ; leur emplacement ne peut donc pas être modifié : {{1}}",
  },
  {
    en: "Migrated ${result.migratedEntries} voucher entries from ${result.accountCode} to employee ${result.employeeCode}",
    ar: "تم نقل {{0}} من بنود السندات من {{1}} إلى الموظف {{2}}",
    fr: "{{0}} lignes de pièces transférées de {{1}} vers l’employé {{2}}",
  },
  {
    en: "Container number cannot be changed: vouchers that mention it are in a closed period (closed through ${outcome.closedThrough}): ${closedVouchers}",
    ar: "لا يمكن تغيير رقم الحاوية: السندات التي تذكره في فترة مقفلة (مقفلة حتى {{0}}): {{1}}",
    fr: "Le numéro du conteneur ne peut pas être modifié : des pièces qui le mentionnent sont dans une période clôturée (clôturée jusqu’au {{0}}) : {{1}}",
  },
  // Phase 19 (B): guards, deletes and rental routes.
  {
    en: "This is a system account: its name cannot be changed.",
    ar: "هذا حساب نظام: لا يمكن تغيير اسمه.",
    fr: "Ceci est un compte système : son nom ne peut pas être modifié.",
  },
  {
    en: "This is a system account: it cannot be deleted.",
    ar: "هذا حساب نظام: لا يمكن حذفه.",
    fr: "Ceci est un compte système : il ne peut pas être supprimé.",
  },
  {
    en: "The parent must be another live account of this company and of the same class, and not one of its sub-accounts.",
    ar: "يجب أن يكون الحساب الأب حساباً آخر نشطاً لهذه الشركة ومن الفئة نفسها، وألا يكون أحد حساباته الفرعية.",
    fr: "Le compte parent doit être un autre compte actif de cette société, de la même classe, et non l’un de ses sous-comptes.",
  },
  {
    en: "This fixed asset has an opening balance, so it cannot be deleted. Move the balance with a journal first.",
    ar: "لهذا الأصل الثابت رصيد افتتاحي، لذا لا يمكن حذفه. انقل الرصيد بقيد يومية أولاً.",
    fr: "Cette immobilisation a un solde d’ouverture et ne peut donc pas être supprimée. Transférez d’abord le solde par une écriture.",
  },
  {
    en: "This fixed asset has voucher lines, so it cannot be deleted. Deactivate it instead.",
    ar: "لهذا الأصل الثابت سطور قيود، لذا لا يمكن حذفه. قم بتعطيله بدلاً من ذلك.",
    fr: "Cette immobilisation a des lignes d’écriture et ne peut donc pas être supprimée. Désactivez-la plutôt.",
  },
  {
    en: "This supplier has history (containers, stock, payments, transfers, voucher lines, linked suppliers or an opening balance), so it cannot be permanently deleted.",
    ar: "لهذا المورد سجل (حاويات أو مخزون أو مدفوعات أو تحويلات أو سطور قيود أو موردون مرتبطون أو رصيد افتتاحي)، لذا لا يمكن حذفه نهائياً.",
    fr: "Ce fournisseur a un historique (conteneurs, stock, paiements, transferts, lignes d’écriture, fournisseurs liés ou solde d’ouverture) et ne peut donc pas être supprimé définitivement.",
  },
  {
    en: "No exchange rate is recorded for this currency on or before the payment date. Enter the dated rate before posting the payment.",
    ar: "لا يوجد سعر صرف مسجل لهذه العملة في تاريخ الدفع أو قبله. أدخل السعر المؤرخ قبل ترحيل الدفعة.",
    fr: "Aucun taux de change n’est enregistré pour cette devise à la date du paiement ou avant. Saisissez le taux daté avant de comptabiliser le paiement.",
  },
  {
    en: "The books are closed through this date, so rent cannot be accrued on it.",
    ar: "الدفاتر مقفلة حتى هذا التاريخ، لذا لا يمكن استحقاق الإيجار فيه.",
    fr: "Les comptes sont clôturés jusqu’à cette date : le loyer ne peut pas y être constaté.",
  },
  {
    en: "There is no stored equity adjustment to clear for this company.",
    ar: "لا توجد تسوية حقوق ملكية مخزّنة لمسحها لهذه الشركة.",
    fr: "Il n’y a aucun ajustement de capitaux propres enregistré à effacer pour cette société.",
  },
  {
    en: "The stored equity adjustment changed since it was reviewed; review it again before clearing.",
    ar: "تغيّرت تسوية حقوق الملكية المخزّنة منذ مراجعتها؛ راجعها مرة أخرى قبل المسح.",
    fr: "L’ajustement de capitaux propres enregistré a changé depuis sa revue ; revoyez-le avant de l’effacer.",
  },
  {
    en: "This company is not a supplier partner: the opening inventory journal absorbs its backfill lines. Reverse them only with an explicit request and a reason.",
    ar: "هذه الشركة ليست شريكاً مورداً: قيد المخزون الافتتاحي يستوعب سطور التعبئة الخلفية الخاصة بها. اعكسها فقط بطلب صريح مع سبب.",
    fr: "Cette société n’est pas un partenaire fournisseur : l’écriture d’ouverture des stocks absorbe ses lignes de reprise. Ne les extournez que sur demande explicite et avec un motif.",
  },
  {
    en: "A reason of at least 10 characters is required to reverse the backfill of this company.",
    ar: "يلزم سبب من 10 أحرف على الأقل لعكس التعبئة الخلفية لهذه الشركة.",
    fr: "Un motif d’au moins 10 caractères est requis pour extourner la reprise de cette société.",
  },
  {
    en: "The contra account of the reversal is deleted; restore it before applying.",
    ar: "الحساب المقابل للعكس محذوف؛ استعده قبل التطبيق.",
    fr: "Le compte de contrepartie de l’extourne est supprimé ; restaurez-le avant d’appliquer.",
  },
  {
    en: "The reversal date is in a closed fiscal period.",
    ar: "تاريخ العكس يقع في فترة مالية مقفلة.",
    fr: "La date de l’extourne se situe dans une période comptable clôturée.",
  },
  {
    en: "There is no backfill line left to reverse.",
    ar: "لم يتبقَّ أي سطر تعبئة خلفية لعكسه.",
    fr: "Il ne reste aucune ligne de reprise à extourner.",
  },
  {
    en: "The backfill reversal changed since it was reviewed; review it again before applying.",
    ar: "تغيّر عكس التعبئة الخلفية منذ مراجعته؛ راجعه مرة أخرى قبل التطبيق.",
    fr: "L’extourne de la reprise a changé depuis sa revue ; revoyez-la avant d’appliquer.",
  },
  {
    en: "offset must be OPENING_BALANCE_EQUITY or INVENTORY_ADJUSTMENT",
    ar: "يجب أن يكون الحساب المقابل OPENING_BALANCE_EQUITY أو INVENTORY_ADJUSTMENT",
    fr: "la contrepartie doit être OPENING_BALANCE_EQUITY ou INVENTORY_ADJUSTMENT",
  },
  {
    en: "Unknown reversal contra account",
    ar: "حساب مقابل غير معروف للعكس",
    fr: "Compte de contrepartie d’extourne inconnu",
  },
  {
    en: "Rates are no longer applied to containers here. Set the rate on the container itself: it uses the recorded factory rate dated on or before the container and updates its journals.",
    ar: "لم تعد الأسعار تُطبَّق على الحاويات من هنا. حدّد السعر على الحاوية نفسها: فهي تستخدم سعر المصنع المسجّل بتاريخ الحاوية أو قبله وتحدّث قيودها.",
    fr: "Les taux ne sont plus appliqués aux conteneurs ici. Saisissez le taux sur le conteneur lui-même : il utilise le taux d’usine enregistré à la date du conteneur ou avant, et met à jour ses écritures.",
  },
  {
    en: "The bales changed while the swap was being prepared; reload and try again",
    ar: "تغيّرت البالات أثناء تحضير الاستبدال؛ أعد التحميل وحاول مرة أخرى",
    fr: "Les balles ont changé pendant la préparation de l’échange ; rechargez et réessayez",
  },
  {
    en: "This journal is a Golden Coast owner withdrawal. Press OK to post the owner-withdrawal template (Dr owner equity, Dr GC Sales Cash, Cr GC Owner Withdrawal Clearing at twice the amount), or Cancel to post it exactly as entered.",
    ar: "هذا القيد سحب مالك لشركة Golden Coast. اضغط موافق لترحيل نموذج سحب المالك (مدين حقوق المالك، مدين GC Sales Cash، دائن حساب مقاصة سحب المالك بضعف المبلغ)، أو إلغاء لترحيله كما أُدخل تماماً.",
    fr: "Cette écriture est un retrait du propriétaire Golden Coast. Appuyez sur OK pour passer le modèle de retrait du propriétaire (débit capitaux du propriétaire, débit GC Sales Cash, crédit compte de compensation des retraits du propriétaire pour le double du montant), ou sur Annuler pour la passer exactement telle que saisie.",
  },
  {
    en: "This journal is not a Golden Coast owner withdrawal; post it without the template.",
    ar: "هذا القيد ليس سحب مالك لشركة Golden Coast؛ رحّله بدون النموذج.",
    fr: "Cette écriture n’est pas un retrait du propriétaire Golden Coast ; passez-la sans le modèle.",
  },
  {
    en: "${GC_OWNER_WITHDRAWAL_CLEARING_CODE} is deleted; restore it from Deleted Items before posting the template",
    ar: "الحساب {{0}} محذوف؛ استعده من العناصر المحذوفة قبل ترحيل النموذج",
    fr: "{{0}} est supprimé ; restaurez-le depuis les éléments supprimés avant de passer le modèle",
  },
  {
    en: "Counterpart line has no positive historical rate",
    ar: "سطر الطرف المقابل ليس له سعر تاريخي موجب",
    fr: "La ligne de contrepartie n’a pas de taux historique positif",
  },
  {
    en: "A POS sale needs a revenue line",
    ar: "يحتاج بيع نقطة البيع إلى سطر إيراد",
    fr: "Une vente au point de vente nécessite une ligne de produit",
  },
  {
    en: "Phantom accrual correction — Dr AP / Cr Rent Expense (${phantomToPost.length} rows)",
    ar: "تصحيح استحقاق وهمي — مدين الدائنين / دائن مصروف الإيجار ({{0}} صفوف)",
    fr: "Correction de régularisation fantôme — débit fournisseurs / crédit charge de loyer ({{0}} lignes)",
  },
  {
    en: "Orphaned AP debit correction (${orphansToPost.length} row(s)) — Dr Rent Expense / Cr AP",
    ar: "تصحيح مدين دائنين يتيم ({{0}} صفوف) — مدين مصروف الإيجار / دائن الدائنين",
    fr: "Correction de débit fournisseurs orphelin ({{0}} ligne(s)) — débit charge de loyer / crédit fournisseurs",
  },
];
