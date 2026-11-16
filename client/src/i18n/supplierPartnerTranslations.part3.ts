import type { Phase4SupplierPartnerEntry } from "./supplierPartnerTranslationTypes";

export const supplierPartnerPhase4TranslationsPart3: readonly Phase4SupplierPartnerEntry[] = [
  { en: "Cutoff Date", ar: "تاريخ القطع", fr: "Date d’arrêté" },
  { en: "Accumulated Profit (USD)", ar: "الربح المتراكم (USD)", fr: "Bénéfice cumulé (USD)" },
  { en: "Our Split %", ar: "نسبة حصتنا %", fr: "Pourcentage de notre part" },
  { en: "Our Share Amount (USD)", ar: "مبلغ حصتنا (USD)", fr: "Montant de notre part (USD)" },
  { en: "Supplier Share Amount (USD)", ar: "مبلغ حصة المورد (USD)", fr: "Montant de la part du fournisseur (USD)" },
  {
    en: "Profit-share opening balance posted",
    ar: "تم ترحيل الرصيد الافتتاحي لحصة الأرباح",
    fr: "Solde d’ouverture de la participation aux bénéfices comptabilisé",
  },
  { en: "Voucher ${r.voucherNumber}", ar: "السند {0}", fr: "Pièce {0}" },
  { en: "Failed", ar: "فشل", fr: "Échec" },
  { en: "Area", ar: "المجال", fr: "Zone" },
  { en: "Detail", ar: "التفصيل", fr: "Détail" },
  {
    en: "Type the source company name exactly to confirm:",
    ar: "اكتب اسم الشركة المصدر تمامًا للتأكيد:",
    fr: "Saisissez exactement le nom de la société source pour confirmer :",
  },
  { en: "${label} complete", ar: "اكتمل {0}", fr: "{0} terminé" },
  { en: "${r.rowsCreated} row(s) created.", ar: "تم إنشاء {0} صف.", fr: "{0} ligne(s) créée(s)." },
  { en: "${label} failed", ar: "فشل {0}", fr: "Échec de {0}" },
  { en: "Step locked", ar: "الخطوة مقفلة", fr: "Étape verrouillée" },
  { en: "Running", ar: "قيد التشغيل", fr: "En cours" },
  { en: "Rolled Back", ar: "تم التراجع", fr: "Annulé" },
  {
    en: "aliasCode and stockItemId required",
    ar: "aliasCode وstockItemId مطلوبان",
    fr: "aliasCode et stockItemId sont requis",
  },
  {
    en: "Alias code already exists for this company",
    ar: "رمز الاسم البديل موجود بالفعل لهذه الشركة",
    fr: "Ce code alias existe déjà pour cette société",
  },
  {
    en: "fromDate and toDate are required (YYYY-MM-DD)",
    ar: "fromDate وtoDate مطلوبان (YYYY-MM-DD)",
    fr: "fromDate et toDate sont requis (AAAA-MM-JJ)",
  },
  { en: "No company selected", ar: "لم يتم اختيار شركة", fr: "Aucune société sélectionnée" },
  {
    en: "Not a supplier_partner company",
    ar: "ليست شركة من نوع supplier_partner",
    fr: "La société n’est pas de type supplier_partner",
  },
  {
    en: "Cutover safety status could not be verified. Write request blocked.",
    ar: "تعذر التحقق من حالة أمان التحويل التشغيلي. تم حظر طلب الكتابة.",
    fr: "L’état de sécurité du basculement n’a pas pu être vérifié. La demande d’écriture est bloquée.",
  },
  {
    en: "Required migration action ${action} is not complete.",
    ar: "إجراء الترحيل المطلوب {0} غير مكتمل.",
    fr: "L’action de migration requise {0} n’est pas terminée.",
  },
  {
    en: 'Target is missing required accounts: ${missingAccounts.map((row: any) => row.sub_type).join(", ")}.',
    ar: "الحسابات المطلوبة التالية مفقودة في الهدف: {0}.",
    fr: "Les comptes requis suivants manquent dans la cible : {0}.",
  },
  {
    en: "${unmappedInventory.length} source inventory row(s) have no safe target stock-item/location mapping.",
    ar: "لا يوجد ربط آمن لصنف المخزون/الموقع المستهدف لعدد {0} من صفوف مخزون المصدر.",
    fr: "{0} ligne(s) de stock source n’ont pas de correspondance sûre d’article/emplacement cible.",
  },
  {
    en: "${stockDiffs.length} inventory row(s) require final quantity/rate synchronization.",
    ar: "يتطلب {0} صف مخزون مزامنة نهائية للكمية/السعر.",
    fr: "{0} ligne(s) de stock nécessitent une synchronisation finale de quantité/taux.",
  },
  {
    en: "${salesDeltaCount} sale voucher(s) require final migration.",
    ar: "يتطلب {0} سند مبيعات ترحيلاً نهائيًا.",
    fr: "{0} pièce(s) de vente nécessitent une migration finale.",
  },
  {
    en: "${containerDeltaCount} container(s) require final migration.",
    ar: "تتطلب {0} حاوية ترحيلاً نهائيًا.",
    fr: "{0} conteneur(s) nécessitent une migration finale.",
  },
  {
    en: "${suspenseReview.count} migrated accounting entry row(s) remain in Migration Suspense.",
    ar: "لا يزال {0} صف من القيود المحاسبية المرحّلة في حساب تعليق الترحيل.",
    fr: "{0} ligne(s) d’écriture comptable migrée(s) restent dans le compte d’attente de migration.",
  },
  {
    en: "${chargeReview} charge mapping(s) need approval and ${chargeUnmapped} remain unmapped.",
    ar: "يحتاج {0} ربط رسوم إلى الموافقة ولا يزال {1} دون ربط.",
    fr: "{0} correspondance(s) de frais nécessitent une approbation et {1} restent non associée(s).",
  },
  {
    en: "${unbalancedCount} migrated voucher(s) are unbalanced.",
    ar: "يوجد {0} سند مرحّل غير متوازن.",
    fr: "{0} pièce(s) migrée(s) sont déséquilibrée(s).",
  },
  {
    en: "Profit-share opening balance has not been posted.",
    ar: "لم يتم ترحيل الرصيد الافتتاحي لحصة الأرباح.",
    fr: "Le solde d’ouverture de la participation aux bénéfices n’a pas été comptabilisé.",
  },
  {
    en: "Target contains ${targetLiveCount} non-migration live transaction(s). Cutover cannot overwrite an active company.",
    ar: "يحتوي الهدف على {0} معاملة تشغيلية حية ليست من الترحيل. لا يمكن للتحويل التشغيلي الكتابة فوق شركة نشطة.",
    fr: "La cible contient {0} transaction(s) active(s) hors migration. Le basculement ne peut pas écraser une société active.",
  },
  {
    en: "${unmappablePosUsers.length} POS user(s) have no safe target location/cash-account mapping.",
    ar: "لا يوجد ربط آمن للموقع/الحساب النقدي المستهدف لعدد {0} من مستخدمي نقطة البيع.",
    fr: "{0} utilisateur(s) du point de vente n’ont pas de correspondance sûre d’emplacement/compte de caisse cible.",
  },
  {
    en: "Target contains ${activity.total} live transaction(s) outside the migration.",
    ar: "يحتوي الهدف على {0} معاملة حية خارج الترحيل.",
    fr: "La cible contient {0} transaction(s) active(s) hors migration.",
  },
  {
    en: "Cutover ${existing.id} is already ${existing.status}.",
    ar: "التحويل التشغيلي {0} حالته بالفعل {1}.",
    fr: "Le basculement {0} est déjà à l’état {1}.",
  },
  {
    en: "Cutover preparation is blocked. Resolve all hard blockers first.",
    ar: "تم حظر إعداد التحويل التشغيلي. عالج جميع العوائق الحرجة أولًا.",
    fr: "La préparation du basculement est bloquée. Résolvez d’abord tous les blocages critiques.",
  },
  {
    en: "Source and target are now locked for final synchronization.",
    ar: "تم الآن قفل المصدر والهدف للمزامنة النهائية.",
    fr: "La source et la cible sont maintenant verrouillées pour la synchronisation finale.",
  },
  {
    en: "Prepare and lock this source/target pair before finalizing.",
    ar: "قم بإعداد وقفل زوج المصدر/الهدف هذا قبل الإنهاء.",
    fr: "Préparez et verrouillez cette paire source/cible avant la finalisation.",
  },
  {
    en: "Cutover finalization is already running or awaiting repair.",
    ar: "إنهاء التحويل التشغيلي قيد التشغيل بالفعل أو بانتظار الإصلاح.",
    fr: "La finalisation du basculement est déjà en cours ou en attente de réparation.",
  },
  {
    en: "Final delta synchronization completed, but review items remain. Resolve them while both companies stay locked, then finalize again.",
    ar: "اكتملت مزامنة الفروقات النهائية، لكن لا تزال عناصر للمراجعة. عالجها مع بقاء الشركتين مقفلتين، ثم نفّذ الإنهاء مجددًا.",
    fr: "La synchronisation finale des écarts est terminée, mais des éléments restent à examiner. Résolvez-les pendant que les deux sociétés restent verrouillées, puis finalisez de nouveau.",
  },
  {
    en: "Supplier Partner cutover is active. The old ERP company is now permanently read-only unless the controlled rollback is used.",
    ar: "التحويل التشغيلي لشريك المورد نشط. أصبحت شركة ERP القديمة للقراءة فقط بشكل دائم ما لم يُستخدم التراجع الخاضع للرقابة.",
    fr: "Le basculement du Partenaire fournisseur est actif. L’ancienne société ERP est désormais définitivement en lecture seule, sauf utilisation de l’annulation contrôlée.",
  },
  {
    en: "Cutover finalization failed: ${message}",
    ar: "فشل إنهاء التحويل التشغيلي: {0}",
    fr: "Échec de la finalisation du basculement : {0}",
  },
  { en: "cutoverId is required", ar: "cutoverId مطلوب", fr: "cutoverId est requis" },
  { en: "Cutover not found", ar: "لم يتم العثور على التحويل التشغيلي", fr: "Basculement introuvable" },
  {
    en: "Only an active cutover can be rolled back.",
    ar: "يمكن التراجع فقط عن تحويل تشغيلي نشط.",
    fr: "Seul un basculement actif peut être annulé.",
  },
  {
    en: "The controlled rollback window has expired.",
    ar: "انتهت مهلة التراجع الخاضع للرقابة.",
    fr: "La fenêtre d’annulation contrôlée a expiré.",
  },
  {
    en: "Rollback is blocked because the Supplier Partner company has live post-cutover activity.",
    ar: "تم حظر التراجع لأن شركة شريك المورد لديها نشاط حي بعد التحويل التشغيلي.",
    fr: "L’annulation est bloquée car la société Partenaire fournisseur contient une activité post-basculement.",
  },
  {
    en: "Operational cutover rolled back. Source users and pre-cutover target inventory were restored.",
    ar: "تم التراجع عن التحويل التشغيلي. تمت استعادة مستخدمي المصدر ومخزون الهدف السابق للتحويل.",
    fr: "Le basculement opérationnel a été annulé. Les utilisateurs source et le stock cible antérieur au basculement ont été restaurés.",
  },
  {
    en: "Only a prepared cutover can be cancelled.",
    ar: "يمكن إلغاء التحويل التشغيلي المُعد فقط.",
    fr: "Seul un basculement préparé peut être annulé.",
  },
  {
    en: "Prepared cutover cancelled; company write locks were removed.",
    ar: "تم إلغاء التحويل التشغيلي المُعد وإزالة أقفال الكتابة عن الشركتين.",
    fr: "Le basculement préparé a été annulé ; les verrous d’écriture des sociétés ont été retirés.",
  },
  {
    en: "targetEntryId and targetLedgerAccountId are required",
    ar: "targetEntryId وtargetLedgerAccountId مطلوبان",
    fr: "targetEntryId et targetLedgerAccountId sont requis",
  },
  {
    en: "Target account does not belong to the target company.",
    ar: "الحساب المستهدف لا ينتمي إلى الشركة المستهدفة.",
    fr: "Le compte cible n’appartient pas à la société cible.",
  },
  {
    en: "Suspense entry was not found or is already mapped.",
    ar: "لم يتم العثور على قيد التعليق أو أنه مربوط بالفعل.",
    fr: "L’écriture d’attente est introuvable ou déjà associée.",
  },
  {
    en: "chargeId and targetLedgerAccountId are required",
    ar: "chargeId وtargetLedgerAccountId مطلوبان",
    fr: "chargeId et targetLedgerAccountId sont requis",
  },
  {
    en: "Charge review row or target account was not found.",
    ar: "لم يتم العثور على صف مراجعة الرسوم أو الحساب المستهدف.",
    fr: "La ligne de contrôle des frais ou le compte cible est introuvable.",
  },
  {
    en: "action must be prepare, finalize, rollback, or cancel",
    ar: "يجب أن يكون action واحدًا من prepare أو finalize أو rollback أو cancel",
    fr: "action doit être prepare, finalize, rollback ou cancel",
  },
  {
    en: "POS user ${sourceRole.user_id} has no safe target location/cash-account mapping.",
    ar: "لا يوجد لمستخدم نقطة البيع {0} ربط آمن للموقع/الحساب النقدي المستهدف.",
    fr: "L’utilisateur du point de vente {0} n’a pas de correspondance sûre d’emplacement/compte de caisse cible.",
  },
  {
    en: "sourceCompanyId and targetCompanyId are required",
    ar: "sourceCompanyId وtargetCompanyId مطلوبان",
    fr: "sourceCompanyId et targetCompanyId sont requis",
  },
];
