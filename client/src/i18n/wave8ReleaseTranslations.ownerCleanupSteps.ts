import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

// Owner "Accounting clean-up" page: the numbered steps and their tools
// (client/src/pages/accounting-cleanup/cleanupSteps.tsx).
export const wave8ReleaseTranslationsOwnerCleanupSteps: readonly Phase3SharedUiEntry[] = [
  // 1
  { en: "Required system accounts", ar: "حسابات النظام المطلوبة", fr: "Comptes système requis" },
  {
    en: "Every company needs these accounts before the other tools can post: retained earnings for the close, rounding for cents, the control accounts and the FX accounts.",
    ar: "تحتاج كل شركة إلى هذه الحسابات قبل أن تتمكن الأدوات الأخرى من الترحيل: الأرباح المحتجزة للإقفال، والتقريب للسنتات، وحسابات المراقبة، وحسابات فروق الصرف.",
    fr: "Chaque société a besoin de ces comptes avant que les autres outils puissent comptabiliser : le report à nouveau pour la clôture, l’arrondi pour les centimes, les comptes collectifs et les comptes de change.",
  },
  {
    en: "It never renames, retypes, restores or deletes an existing account; it only creates missing ones.",
    ar: "لا يعيد أبداً تسمية حساب موجود أو تغيير نوعه أو استعادته أو حذفه؛ ينشئ الحسابات المفقودة فقط.",
    fr: "Il ne renomme, ne retype, ne restaure ni ne supprime jamais un compte existant ; il crée seulement les comptes manquants.",
  },
  {
    en: "Lists RETAINED_EARNINGS, OPENING_BALANCE_EQUITY, ROUNDING, the receivable, payable and payroll control accounts and the two FX accounts; Apply creates the missing ones.",
    ar: "يعرض RETAINED_EARNINGS وOPENING_BALANCE_EQUITY وROUNDING وحسابات مراقبة الذمم المدينة والدائنة والرواتب وحسابَي فروق الصرف؛ وينشئ التطبيق المفقود منها.",
    fr: "Liste RETAINED_EARNINGS, OPENING_BALANCE_EQUITY, ROUNDING, les comptes collectifs clients, fournisseurs et paie et les deux comptes de change ; Appliquer crée ceux qui manquent.",
  },
  // 2
  { en: "Dated exchange rates", ar: "أسعار الصرف المؤرخة", fr: "Taux de change datés" },
  {
    en: "Enter or import the rate of every date on which foreign-currency documents exist (back to February 2026). The prepared ECB table can be imported as it is; the preview shows which rows are new, identical or differ from a recorded rate.",
    ar: "أدخل أو استورد سعر كل تاريخ توجد فيه مستندات بعملة أجنبية (رجوعاً إلى فبراير 2026). يمكن استيراد جدول البنك المركزي الأوروبي المُعدّ كما هو؛ وتُظهر المعاينة الأسطر الجديدة والمطابقة والمختلفة عن سعر مسجل.",
    fr: "Saisissez ou importez le taux de chaque date où existent des documents en devise (depuis février 2026). La table BCE préparée s’importe telle quelle ; l’aperçu indique les lignes nouvelles, identiques ou différentes d’un taux enregistré.",
  },
  {
    en: "It never accepts a rate dated after today and never changes a rate silently: a differing rate is replaced only when you tick it.",
    ar: "لا يقبل أبداً سعراً مؤرخاً بعد اليوم ولا يغيّر سعراً دون علمك: لا يُستبدل السعر المختلف إلا إذا حددته.",
    fr: "Il n’accepte jamais un taux daté après aujourd’hui et ne change jamais un taux en silence : un taux différent n’est remplacé que si vous le cochez.",
  },
  // 3
  { en: "Factory FX repair", ar: "إصلاح فروق صرف المصنع", fr: "Réparation du change de l’usine" },
  {
    en: "Converts legacy factory foreign-currency lines at their voucher's stored rate, or the dated factory rate entered in step 2.",
    ar: "يحوّل أسطر المصنع القديمة بالعملة الأجنبية بالسعر المخزن في قيدها، أو بسعر المصنع المؤرخ المُدخل في الخطوة 2.",
    fr: "Convertit les lignes héritées de l’usine en devise au taux enregistré de leur pièce, ou au taux d’usine daté saisi à l’étape 2.",
  },
  {
    en: "It never guesses a rate: lines with no rate are listed and skipped.",
    ar: "لا يخمّن سعراً أبداً: تُعرض الأسطر التي لا سعر لها وتُتخطى.",
    fr: "Il ne devine jamais un taux : les lignes sans taux sont listées et ignorées.",
  },
  { en: "Legacy factory FX lines", ar: "أسطر صرف المصنع القديمة", fr: "Lignes de change héritées de l’usine" },
  {
    en: "Preview the lines it converts, by target, with the USD change; apply the reviewed plan.",
    ar: "عاين الأسطر التي يحوّلها، حسب الحساب، مع تغيّر الدولار؛ ثم طبّق الخطة المراجَعة.",
    fr: "Prévisualisez les lignes converties, par cible, avec la variation en USD ; appliquez le plan revu.",
  },
  {
    en: "Applying is a maintenance action: an Admin with the repair permission applies it after the Owner reviews the preview.",
    ar: "التطبيق إجراء صيانة: يطبّقه مسؤول لديه صلاحية الإصلاح بعد أن يراجع المالك المعاينة.",
    fr: "Appliquer est une action de maintenance : un administrateur ayant l’autorisation de réparation l’applique une fois que le propriétaire a revu l’aperçu.",
  },
  // 4
  { en: "Plug values", ar: "قيم الموازنة المصطنعة", fr: "Valeurs d’équilibrage" },
  {
    en: "The stored equity adjustment hid each company's import-cycle difference. Investigate the difference, post the reviewed corrections, then clear the stored value.",
    ar: "أخفت تسوية حقوق الملكية المخزنة فرق دورة الاستيراد لكل شركة. تحقّق من الفرق ورحّل التصحيحات المراجَعة ثم امسح القيمة المخزنة.",
    fr: "L’ajustement de capitaux enregistré masquait l’écart du cycle d’import de chaque société. Analysez l’écart, comptabilisez les corrections revues, puis effacez la valeur enregistrée.",
  },
  {
    en: "Clearing never posts a journal and never changes a balance: it removes the stored figure, audited.",
    ar: "المسح لا يرحّل قيداً ولا يغيّر رصيداً أبداً: يزيل الرقم المخزن مع تدقيقه.",
    fr: "L’effacement ne comptabilise jamais de journal et ne change jamais un solde : il supprime la valeur enregistrée, avec audit.",
  },
  {
    en: "Open Import Cycle Diagnostics",
    ar: "افتح تشخيص دورة الاستيراد",
    fr: "Ouvrir le diagnostic du cycle d’import",
  },
  {
    en: "Investigate each company's import-cycle difference there and post the reviewed corrections first.",
    ar: "تحقّق هناك من فرق دورة الاستيراد لكل شركة ورحّل التصحيحات المراجَعة أولاً.",
    fr: "Analysez-y l’écart du cycle d’import de chaque société et comptabilisez d’abord les corrections revues.",
  },
  {
    en: "Clear the stored equity adjustment",
    ar: "امسح تسوية حقوق الملكية المخزنة",
    fr: "Effacer l’ajustement de capitaux enregistré",
  },
  {
    en: "Shows the stored value and the live import-cycle difference it hid.",
    ar: "يعرض القيمة المخزنة وفرق دورة الاستيراد الحالي الذي أخفته.",
    fr: "Affiche la valeur enregistrée et l’écart actuel du cycle d’import qu’elle masquait.",
  },
  // 5
  {
    en: "Backfill reversal (company 10)",
    ar: "عكس الإكمال القديم (الشركة 10)",
    fr: "Contre-passation du complément (société 10)",
  },
  {
    en: "Reverses the INVENTORY lines the old boot backfill added to stock adjustment vouchers of a supplier-partner company, with a reversing journal against the contra account you choose.",
    ar: "يعكس أسطر INVENTORY التي أضافها الإكمال القديم عند الإقلاع إلى قيود تسوية المخزون لشركة مورد شريك، بقيد عكسي مقابل الحساب الذي تختاره.",
    fr: "Contre-passe les lignes INVENTORY que l’ancien complément au démarrage a ajoutées aux pièces d’ajustement de stock d’une société fournisseur partenaire, par un journal de contre-passation sur le compte de contrepartie choisi.",
  },
  {
    en: "For other companies it refuses unless you tick the override and give a reason; it never edits the original vouchers.",
    ar: "يرفض للشركات الأخرى ما لم تحدد التجاوز وتذكر سبباً؛ ولا يعدّل القيود الأصلية أبداً.",
    fr: "Pour les autres sociétés, il refuse sauf si vous cochez la dérogation et donnez un motif ; il ne modifie jamais les pièces d’origine.",
  },
  {
    en: "Stock adjustment backfill lines",
    ar: "أسطر إكمال تسوية المخزون",
    fr: "Lignes de complément des ajustements de stock",
  },
  {
    en: "Preview per voucher the reversing journal; the reason and the override are part of the plan.",
    ar: "عاين القيد العكسي لكل قيد؛ السبب والتجاوز جزء من الخطة.",
    fr: "Prévisualisez par pièce le journal de contre-passation ; le motif et la dérogation font partie du plan.",
  },
  // 6
  { en: "Insurance journal direction", ar: "اتجاه قيود التأمين", fr: "Sens des journaux d’assurance" },
  {
    en: "Old generated insurance journals were posted the wrong way round; the tool swaps debit and credit on those vouchers.",
    ar: "رُحّلت قيود التأمين القديمة المولّدة بالاتجاه المعاكس؛ تبادل الأداة المدين والدائن في تلك القيود.",
    fr: "Les anciens journaux d’assurance générés ont été comptabilisés à l’envers ; l’outil inverse débit et crédit sur ces pièces.",
  },
  {
    en: "It never touches a voucher whose pattern is not proven or that is in a closed period: those are listed as skipped.",
    ar: "لا يمس أبداً قيداً لم يثبت نمطه أو يقع في فترة مقفلة: تُعرض هذه كمتخطاة.",
    fr: "Il ne touche jamais une pièce dont le schéma n’est pas prouvé ou qui est dans une période clôturée : elles sont listées comme ignorées.",
  },
  { en: "Reversed insurance journals", ar: "قيود التأمين المعكوسة", fr: "Journaux d’assurance inversés" },
  {
    en: "Preview each voucher and line before and after.",
    ar: "عاين كل قيد وسطر قبل التغيير وبعده.",
    fr: "Prévisualisez chaque pièce et chaque ligne avant et après.",
  },
  // 7
  {
    en: "Rent: legacy prepaid recognition and deferred rent",
    ar: "الإيجار: إثبات المدفوع مقدماً القديم والإيجار المؤجل",
    fr: "Loyers : constatation des loyers prépayés hérités et loyers différés",
  },
  {
    en: "Recognises the legacy fully prepaid shop rent months the daily job used to post, and (Properties companies) moves the Deferred Rent Revenue balance to Rental Income.",
    ar: "يثبت أشهر إيجار المحلات المدفوعة مقدماً بالكامل التي كانت المهمة اليومية ترحّلها، و(لشركات العقارات) ينقل رصيد إيرادات الإيجار المؤجلة إلى إيرادات الإيجار.",
    fr: "Constate les mois de loyer de boutique entièrement prépayés que la tâche quotidienne comptabilisait, et (sociétés Properties) transfère le solde des loyers différés en revenus locatifs.",
  },
  {
    en: "It never posts into a closed period and never guesses an ambiguous month: those are listed as skipped.",
    ar: "لا يرحّل أبداً في فترة مقفلة ولا يخمّن شهراً ملتبساً: تُعرض هذه كمتخطاة.",
    fr: "Il ne comptabilise jamais dans une période clôturée et ne devine jamais un mois ambigu : ils sont listés comme ignorés.",
  },
  {
    en: "ERP shops: legacy prepaid rent",
    ar: "محلات ERP: الإيجار المدفوع مقدماً القديم",
    fr: "Boutiques ERP : loyers prépayés hérités",
  },
  {
    en: "Factory shops: legacy prepaid rent",
    ar: "محلات المصنع: الإيجار المدفوع مقدماً القديم",
    fr: "Boutiques de l’usine : loyers prépayés hérités",
  },
  {
    en: "Preview the reclassification and recognition journal of each month.",
    ar: "عاين قيد إعادة التصنيف والإثبات لكل شهر.",
    fr: "Prévisualisez le journal de reclassement et de constatation de chaque mois.",
  },
  {
    en: "Properties: deferred rent reclassification",
    ar: "العقارات: إعادة تصنيف الإيجار المؤجل",
    fr: "Properties : reclassement des loyers différés",
  },
  {
    en: "Should be empty; preview to confirm. Applies to Properties companies only.",
    ar: "يُفترض أن تكون فارغة؛ عاين للتأكد. تنطبق على شركات العقارات فقط.",
    fr: "Devrait être vide ; prévisualisez pour le confirmer. S’applique aux sociétés Properties uniquement.",
  },
  // 8
  { en: "Phase 3 historical repair", ar: "إصلاح المرحلة 3 التاريخي", fr: "Réparation historique de la phase 3" },
  {
    en: "Adds the missing Purchases debits of legacy purchase orders and the missing inventory legs of notes, rebuilds unbalanced payroll periods and removes company 1's duplicate POS lines.",
    ar: "يضيف مدينات المشتريات المفقودة لأوامر الشراء القديمة وأطراف المخزون المفقودة في الإشعارات، ويعيد بناء فترات الرواتب غير المتوازنة ويزيل أسطر نقاط البيع المكررة للشركة 1.",
    fr: "Ajoute les débits d’achats manquants des anciens bons de commande et les jambes de stock manquantes des avoirs, reconstruit les périodes de paie déséquilibrées et supprime les lignes de caisse en double de la société 1.",
  },
  {
    en: "It never changes a voucher in a closed period; each change is in the plan before it is applied.",
    ar: "لا يغيّر أبداً قيداً في فترة مقفلة؛ كل تغيير يظهر في الخطة قبل تطبيقه.",
    fr: "Il ne modifie jamais une pièce d’une période clôturée ; chaque changement figure dans le plan avant d’être appliqué.",
  },
  { en: "Historical voucher repair", ar: "إصلاح القيود التاريخية", fr: "Réparation des pièces historiques" },
  {
    en: "Preview every voucher it completes.",
    ar: "عاين كل قيد يكمله.",
    fr: "Prévisualisez chaque pièce qu’il complète.",
  },
  // 9
  {
    en: "Supplier Partner voucher links",
    ar: "روابط قيود المورد الشريك",
    fr: "Liens des pièces du fournisseur partenaire",
  },
  {
    en: "Sets the supplier on Supplier Partner goods-in-transit vouchers whose lines name the wrong supplier.",
    ar: "يضبط المورد في قيود البضاعة بالطريق للمورد الشريك التي تذكر أسطرها مورداً خاطئاً.",
    fr: "Fixe le fournisseur sur les pièces de marchandises en transit du fournisseur partenaire dont les lignes citent le mauvais fournisseur.",
  },
  {
    en: "It never changes amounts and skips vouchers in a closed period.",
    ar: "لا يغيّر المبالغ أبداً ويتخطى القيود في فترة مقفلة.",
    fr: "Il ne modifie jamais les montants et ignore les pièces d’une période clôturée.",
  },
  {
    en: "Goods-in-transit supplier links",
    ar: "روابط موردي البضاعة بالطريق",
    fr: "Liens fournisseurs des marchandises en transit",
  },
  {
    en: "Preview each voucher and line whose supplier would change.",
    ar: "عاين كل قيد وسطر سيتغير مورده.",
    fr: "Prévisualisez chaque pièce et ligne dont le fournisseur changerait.",
  },
  // 10
  {
    en: "Chart of accounts: legacy lines, opening journal, reclassification",
    ar: "دليل الحسابات: الأسطر القديمة، القيد الافتتاحي، إعادة التصنيف",
    fr: "Plan comptable : lignes héritées, journal d’ouverture, reclassement",
  },
  {
    en: "Moves legacy lines on missing, deleted or other companies' accounts to a reviewed account, then validates the ledger constraints; posts the openings as one opening journal at the cut-over date; moves account balances by a reclassification journal.",
    ar: "ينقل الأسطر القديمة على حسابات مفقودة أو محذوفة أو تابعة لشركات أخرى إلى حساب مراجَع ثم يتحقق من قيود الدفتر؛ ويرحّل الأرصدة الافتتاحية كقيد افتتاحي واحد في تاريخ الانتقال؛ وينقل أرصدة الحسابات بقيد إعادة تصنيف.",
    fr: "Transfère les lignes héritées sur des comptes manquants, supprimés ou d’autres sociétés vers un compte revu, puis valide les contraintes du grand livre ; comptabilise les ouvertures en un journal d’ouverture à la date de bascule ; transfère des soldes de comptes par un journal de reclassement.",
  },
  {
    en: "None of them edits a posted line in place: each posts a journal, and the opening journal is applied once.",
    ar: "لا يعدّل أيٌّ منها سطراً مرحّلاً في مكانه: كلٌّ منها يرحّل قيداً، ويُطبَّق القيد الافتتاحي مرة واحدة.",
    fr: "Aucun ne modifie une ligne comptabilisée sur place : chacun comptabilise un journal, et le journal d’ouverture est appliqué une seule fois.",
  },
  { en: "Legacy line reclassification", ar: "إعادة تصنيف الأسطر القديمة", fr: "Reclassement des lignes héritées" },
  {
    en: "Preview the lines by kind and the reclassification journal; optional destination account.",
    ar: "عاين الأسطر حسب النوع وقيد إعادة التصنيف؛ الحساب الوجهة اختياري.",
    fr: "Prévisualisez les lignes par type et le journal de reclassement ; compte de destination facultatif.",
  },
  { en: "Validate the ledger constraints", ar: "تحقّق من قيود الدفتر", fr: "Valider les contraintes du grand livre" },
  {
    en: "After the legacy lines are reclassified: validates the ledger guard constraints wherever no line breaks them any more, and lists the others.",
    ar: "بعد إعادة تصنيف الأسطر القديمة: يتحقق من قيود حماية الدفتر حيث لم يعد أي سطر يخالفها، ويعرض البقية.",
    fr: "Après le reclassement des lignes héritées : valide les contraintes de protection du grand livre là où plus aucune ligne ne les enfreint, et liste les autres.",
  },
  { en: "Opening journal", ar: "القيد الافتتاحي", fr: "Journal d’ouverture" },
  {
    en: "Choose the cut-over date (suggested in the plan), preview the journal, apply once.",
    ar: "اختر تاريخ الانتقال (مقترح في الخطة)، وعاين القيد، وطبّقه مرة واحدة.",
    fr: "Choisissez la date de bascule (suggérée dans le plan), prévisualisez le journal, appliquez une fois.",
  },
  { en: "Account reclassification", ar: "إعادة تصنيف الحسابات", fr: "Reclassement de comptes" },
  {
    en: "Moves the balances of source accounts on a date to one destination account by a journal.",
    ar: "ينقل أرصدة الحسابات المصدر في تاريخ ما إلى حساب وجهة واحد بقيد.",
    fr: "Transfère les soldes de comptes source à une date vers un compte de destination par un journal.",
  },
  {
    en: "Enter the source accounts, the destination account and the date to preview.",
    ar: "أدخل الحسابات المصدر والحساب الوجهة والتاريخ للمعاينة.",
    fr: "Saisissez les comptes source, le compte de destination et la date pour prévisualiser.",
  },
  // 11
  {
    en: "Month-end FX revaluation",
    ar: "إعادة تقييم فروق الصرف في نهاية الشهر",
    fr: "Réévaluation de change de fin de mois",
  },
  {
    en: "Revalues every foreign-currency monetary balance at the rate recorded on the month end, posted to UNREALIZED_FX and reversed on the first day of the next month.",
    ar: "يعيد تقييم كل رصيد نقدي بعملة أجنبية بالسعر المسجل في نهاية الشهر، ويرحّله إلى UNREALIZED_FX ويعكسه في أول يوم من الشهر التالي.",
    fr: "Réévalue chaque solde monétaire en devise au taux enregistré en fin de mois, comptabilisé sur UNREALIZED_FX et contre-passé le premier jour du mois suivant.",
  },
  {
    en: "It never revalues a currency with no rate on the month end (listed as rate missing) and is applied once per month.",
    ar: "لا يعيد أبداً تقييم عملة بلا سعر في نهاية الشهر (تُعرض كسعر مفقود)، ويُطبَّق مرة واحدة في الشهر.",
    fr: "Il ne réévalue jamais une devise sans taux en fin de mois (listée comme taux manquant) et s’applique une fois par mois.",
  },
  { en: "Revaluation at a month end", ar: "إعادة التقييم في نهاية شهر", fr: "Réévaluation à une fin de mois" },
  {
    en: "Choose the month end, preview the adjustments and the currencies with no rate.",
    ar: "اختر نهاية الشهر، وعاين التسويات والعملات التي لا سعر لها.",
    fr: "Choisissez la fin de mois, prévisualisez les ajustements et les devises sans taux.",
  },
  {
    en: "Choose the month end to preview.",
    ar: "اختر نهاية الشهر للمعاينة.",
    fr: "Choisissez la fin de mois pour prévisualiser.",
  },
  // 12
  {
    en: "Open items: first allocation and realized FX history",
    ar: "البنود المفتوحة: التخصيص الأول وتاريخ فروق الصرف المحققة",
    fr: "Postes ouverts : première imputation et historique du change réalisé",
  },
  {
    en: "The first allocation run of a company (receipts and notes matched to invoices, oldest due first) is the Owner's; it also turns on the hourly run. Then review the realized FX of the history it allocated.",
    ar: "أول تشغيل للتخصيص في الشركة (مطابقة المقبوضات والإشعارات مع الفواتير، الأقدم استحقاقاً أولاً) من صلاحية المالك؛ ويفعّل أيضاً التشغيل كل ساعة. ثم راجع فروق الصرف المحققة للتاريخ الذي خصصه.",
    fr: "La première imputation d’une société (encaissements et avoirs rapprochés des factures, échéance la plus ancienne d’abord) revient au propriétaire ; elle active aussi l’exécution horaire. Revoyez ensuite le change réalisé de l’historique imputé.",
  },
  {
    en: "The first run posts no FX journal; the history tool posts only the differences in its plan.",
    ar: "لا يرحّل التشغيل الأول أي قيد فروق صرف؛ وأداة التاريخ ترحّل الفروق الموجودة في خطتها فقط.",
    fr: "La première exécution ne comptabilise aucun journal de change ; l’outil d’historique ne comptabilise que les écarts de son plan.",
  },
  { en: "First allocation run", ar: "أول تشغيل للتخصيص", fr: "Première imputation" },
  {
    en: "Preview per party kind the allocations it creates and releases.",
    ar: "عاين حسب نوع الطرف التخصيصات التي ينشئها ويحررها.",
    fr: "Prévisualisez par type de tiers les imputations créées et libérées.",
  },
  {
    en: "Realized FX of allocated history",
    ar: "فروق الصرف المحققة للتاريخ المخصص",
    fr: "Change réalisé de l’historique imputé",
  },
  {
    en: "Preview the exchange difference of each allocation between foreign-currency documents.",
    ar: "عاين فرق الصرف لكل تخصيص بين مستندات بعملة أجنبية.",
    fr: "Prévisualisez l’écart de change de chaque imputation entre documents en devise.",
  },
  { en: "Open-items diagnostics", ar: "تشخيص البنود المفتوحة", fr: "Diagnostic des postes ouverts" },
  {
    en: "Read only: the customer balance memo, employee cache, book amount column and allocation tie-out.",
    ar: "للقراءة فقط: مذكرة أرصدة العملاء، وذاكرة الموظفين، وعمود المبلغ الدفتري، ومطابقة التخصيص.",
    fr: "Lecture seule : le mémo des soldes clients, le cache des employés, la colonne de montant comptable et le rapprochement des imputations.",
  },
  // 13
  {
    en: "Multi-company: company 13 lines and diagnostic",
    ar: "تعدد الشركات: أسطر الشركة 13 والتشخيص",
    fr: "Multi-sociétés : lignes de la société 13 et diagnostic",
  },
  {
    en: "Lines a voucher posted to another company's account are corrected by reversal and re-post in the right company; the diagnostic lists what is left.",
    ar: "تُصحَّح الأسطر التي رحّلها قيد على حساب شركة أخرى بالعكس وإعادة الترحيل في الشركة الصحيحة؛ ويعرض التشخيص ما تبقى.",
    fr: "Les lignes qu’une pièce a comptabilisées sur le compte d’une autre société sont corrigées par contre-passation et nouvelle comptabilisation dans la bonne société ; le diagnostic liste ce qui reste.",
  },
  {
    en: "It never edits a line in place and leaves blocked vouchers as they are, with the reason.",
    ar: "لا يعدّل سطراً في مكانه أبداً ويترك القيود المحجوبة كما هي مع السبب.",
    fr: "Il ne modifie jamais une ligne sur place et laisse les pièces bloquées telles quelles, avec le motif.",
  },
  { en: "Cross-company lines", ar: "الأسطر بين الشركات", fr: "Lignes inter-sociétés" },
  {
    en: "Choose who owns the lines and, if needed, an account map; preview per voucher.",
    ar: "اختر مالك الأسطر، وخريطة حسابات عند الحاجة؛ ثم عاين لكل قيد.",
    fr: "Choisissez à qui appartiennent les lignes et, si besoin, une correspondance de comptes ; prévisualisez par pièce.",
  },
  {
    en: "The account map must be a JSON object of account ids.",
    ar: "يجب أن تكون خريطة الحسابات كائن JSON لأرقام الحسابات.",
    fr: "La correspondance de comptes doit être un objet JSON d’identifiants de comptes.",
  },
  { en: "Multi-company diagnostic", ar: "تشخيص تعدد الشركات", fr: "Diagnostic multi-sociétés" },
  {
    en: "Read only: intercompany links, parents and cross-company lines.",
    ar: "للقراءة فقط: الروابط بين الشركات، والشركات الأم، والأسطر بين الشركات.",
    fr: "Lecture seule : liens intersociétés, sociétés mères et lignes inter-sociétés.",
  },
  // 14
  {
    en: "Factory and inventory go-live (not the switch)",
    ar: "إطلاق المصنع والمخزون (دون المفتاح)",
    fr: "Mise en service usine et inventaire (sans la bascule)",
  },
  {
    en: "In order: opening receivable at the cut-over, no-mix bales, back-fill of legacy factory postings, bale re-cost, bale-mirror write-off, readiness resolution, then the opening plan, readiness and reconciliation. The perpetual switch itself stays a code flag.",
    ar: "بالترتيب: الذمم الافتتاحية عند الانتقال، والبالات بلا خلطة، وإكمال ترحيلات المصنع القديمة، وإعادة تكلفة البالات، وشطب مرآة البالات، ومعالجة الجاهزية، ثم الخطة الافتتاحية والجاهزية والمطابقة. يبقى مفتاح الجرد الدائم نفسه علامة في الشيفرة.",
    fr: "Dans l’ordre : créances d’ouverture à la bascule, balles sans mélange, complément des écritures héritées de l’usine, recalcul du coût des balles, passage en perte du miroir des balles, résolution de préparation, puis le plan d’ouverture, la préparation et le rapprochement. La bascule permanente elle-même reste un indicateur du code.",
  },
  {
    en: "Nothing here turns perpetual posting on.",
    ar: "لا شيء هنا يفعّل الترحيل الدائم.",
    fr: "Rien ici n’active la comptabilisation permanente.",
  },
  { en: "Factory opening receivable", ar: "ذمم المصنع الافتتاحية", fr: "Créances d’ouverture de l’usine" },
  {
    en: "Choose the receivable cut-over date; preview the opening journal per currency.",
    ar: "اختر تاريخ انتقال الذمم؛ وعاين القيد الافتتاحي لكل عملة.",
    fr: "Choisissez la date de bascule des créances ; prévisualisez le journal d’ouverture par devise.",
  },
  {
    en: "Choose the cut-over date to preview.",
    ar: "اختر تاريخ الانتقال للمعاينة.",
    fr: "Choisissez la date de bascule pour prévisualiser.",
  },
  { en: "Bales without a costed mix", ar: "بالات بلا خلطة مُكلفة", fr: "Balles sans mélange valorisé" },
  {
    en: "For each bale: assign to its candidate mix, write off to waste, or accept its cost with a sign-off.",
    ar: "لكل بالة: خصّصها لخلطتها المرشحة، أو اشطبها كهالك، أو اقبل تكلفتها مع توقيع.",
    fr: "Pour chaque balle : affecter à son mélange candidat, passer en déchet, ou accepter son coût avec un visa.",
  },
  {
    en: "Back-fill legacy factory postings",
    ar: "إكمال ترحيلات المصنع القديمة",
    fr: "Compléter les écritures héritées de l’usine",
  },
  {
    en: "V3 loads, commissions, container import journals and freight lines with no target.",
    ar: "حمولات V3، والعمولات، وقيود استيراد الحاويات، وأسطر الشحن بلا حساب.",
    fr: "Chargements V3, commissions, journaux d’import des conteneurs et lignes de fret sans cible.",
  },
  { en: "Bale re-cost", ar: "إعادة تكلفة البالات", fr: "Recalcul du coût des balles" },
  {
    en: "Preview per mix and bale the old and new USD cost; apply the reviewed plan.",
    ar: "عاين لكل خلطة وبالة التكلفة القديمة والجديدة بالدولار؛ ثم طبّق الخطة المراجَعة.",
    fr: "Prévisualisez par mélange et par balle l’ancien et le nouveau coût en USD ; appliquez le plan revu.",
  },
  { en: "ERP bale-mirror write-off", ar: "شطب مرآة البالات في ERP", fr: "Passage en perte du miroir des balles ERP" },
  {
    en: "Writes off the values left on the ERP bale-mirror stock rows.",
    ar: "يشطب القيم المتبقية على أسطر مخزون مرآة البالات في ERP.",
    fr: "Passe en perte les valeurs restées sur les lignes de stock miroir des balles ERP.",
  },
  { en: "Readiness resolution", ar: "معالجة الجاهزية", fr: "Résolution de préparation" },
  {
    en: "Stock at missing locations (restore or write off) and anomalous values (write off).",
    ar: "المخزون في مواقع مفقودة (استعادة أو شطب) والقيم الشاذة (شطب).",
    fr: "Stock sur des emplacements manquants (restaurer ou passer en perte) et valeurs anormales (passer en perte).",
  },
  {
    en: "Perpetual opening plan",
    ar: "الخطة الافتتاحية للجرد الدائم",
    fr: "Plan d’ouverture de l’inventaire permanent",
  },
  {
    en: "Read only: the opening inventory journal the cut-over would post (applied with the switch, in code).",
    ar: "للقراءة فقط: قيد المخزون الافتتاحي الذي سيرحّله الانتقال (يُطبَّق مع المفتاح، في الشيفرة).",
    fr: "Lecture seule : le journal d’inventaire d’ouverture que la bascule comptabiliserait (appliqué avec la bascule, dans le code).",
  },
  { en: "Perpetual readiness", ar: "جاهزية الجرد الدائم", fr: "Préparation de l’inventaire permanent" },
  {
    en: "Read only: every blocker left before the cut-over.",
    ar: "للقراءة فقط: كل العوائق المتبقية قبل الانتقال.",
    fr: "Lecture seule : chaque blocage restant avant la bascule.",
  },
  {
    en: "Read only: the ledger against the stock sub-ledgers, account by account.",
    ar: "للقراءة فقط: الدفتر مقابل دفاتر المخزون الفرعية، حساباً بحساب.",
    fr: "Lecture seule : le grand livre face aux sous-livres de stock, compte par compte.",
  },
  // 15
  { en: "First fiscal close", ar: "أول إقفال مالي", fr: "Première clôture comptable" },
  {
    en: "Check that the trial balance is balanced, RETAINED_EARNINGS exists and no account of an unknown type carries a balance, then close the period with the existing close and reopen flow.",
    ar: "تحقّق من أن ميزان المراجعة متوازن، وأن RETAINED_EARNINGS موجود، وأنه لا يوجد رصيد على حساب من نوع غير معروف، ثم أقفل الفترة بمسار الإقفال وإعادة الفتح الحالي.",
    fr: "Vérifiez que la balance générale est équilibrée, que RETAINED_EARNINGS existe et qu’aucun compte de type inconnu ne porte de solde, puis clôturez la période avec le flux existant de clôture et de réouverture.",
  },
  {
    en: "The pre-check changes nothing; the close posts the closing journal and turns the period lock on.",
    ar: "الفحص المسبق لا يغيّر شيئاً؛ والإقفال يرحّل قيد الإقفال ويفعّل قفل الفترة.",
    fr: "La pré-vérification ne change rien ; la clôture comptabilise le journal de clôture et active le verrouillage de la période.",
  },
];
