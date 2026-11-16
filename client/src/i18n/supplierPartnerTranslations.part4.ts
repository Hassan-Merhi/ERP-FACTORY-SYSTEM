import type { Phase4SupplierPartnerEntry } from "./supplierPartnerTranslationTypes";

export const supplierPartnerPhase4TranslationsPart4: readonly Phase4SupplierPartnerEntry[] = [
  {
    en: "Source and target companies must be different",
    ar: "يجب أن تكون شركتا المصدر والهدف مختلفتين",
    fr: "Les sociétés source et cible doivent être différentes",
  },
  {
    en: "Final Supplier Partner verification failed",
    ar: "فشل التحقق النهائي من شريك المورد",
    fr: "Échec de la vérification finale du Partenaire fournisseur",
  },
  { en: "Source company not found", ar: "لم يتم العثور على الشركة المصدر", fr: "Société source introuvable" },
  { en: "Target company not found", ar: "لم يتم العثور على الشركة المستهدفة", fr: "Société cible introuvable" },
  {
    en: "Source company must be type 'erp'",
    ar: "يجب أن تكون الشركة المصدر من النوع 'erp'",
    fr: "La société source doit être de type 'erp'",
  },
  {
    en: "Target company must be type 'supplier_partner'",
    ar: "يجب أن تكون الشركة المستهدفة من النوع 'supplier_partner'",
    fr: "La société cible doit être de type 'supplier_partner'",
  },
  {
    en: 'Requires confirmation = "MIGRATE"',
    ar: 'يتطلب confirmation = "MIGRATE"',
    fr: 'Nécessite confirmation = "MIGRATE"',
  },
  {
    en: 'Company name confirmation must match exactly: "${sourceCompany.name}"',
    ar: 'يجب أن يطابق تأكيد اسم الشركة تمامًا: "{0}"',
    fr: 'La confirmation du nom de la société doit correspondre exactement à : "{0}"',
  },
  {
    en: 'Supplier "${fallbackName}" matched more than one supplier record.',
    ar: 'تطابق المورد "{0}" مع أكثر من سجل مورد واحد.',
    fr: 'Le fournisseur "{0}" correspond à plusieurs enregistrements fournisseur.',
  },
  {
    en: 'Supplier "${fallbackName || sourceSupplierId || "unknown"}" could not be matched automatically.',
    ar: 'تعذر مطابقة المورد "{0}" تلقائيًا.',
    fr: 'Le fournisseur "{0}" n’a pas pu être associé automatiquement.',
  },
  { en: "runId is required", ar: "runId مطلوب", fr: "runId est requis" },
  { en: "Invalid rollback confirmation", ar: "تأكيد التراجع غير صالح", fr: "Confirmation d’annulation non valide" },
  { en: "Migration run not found", ar: "لم يتم العثور على عملية الترحيل", fr: "Exécution de migration introuvable" },
  { en: "Run is already rolled back", ar: "تم التراجع عن العملية بالفعل", fr: "L’exécution a déjà été annulée" },
  {
    en: "A running migration cannot be rolled back",
    ar: "لا يمكن التراجع عن ترحيل قيد التشغيل",
    fr: "Une migration en cours ne peut pas être annulée",
  },
  {
    en: "Rollback safety check failed",
    ar: "فشل فحص أمان التراجع",
    fr: "Échec du contrôle de sécurité de l’annulation",
  },
  {
    en: "Failed to load migration suspense review",
    ar: "فشل تحميل مراجعة حساب تعليق الترحيل",
    fr: "Échec du chargement du contrôle du compte d’attente de migration",
  },
  {
    en: "Failed to load migrated container charge review",
    ar: "فشل تحميل مراجعة رسوم الحاويات المرحّلة",
    fr: "Échec du chargement du contrôle des frais de conteneurs migrés",
  },
  {
    en: "Migration Suspense account is missing.",
    ar: "حساب تعليق الترحيل مفقود.",
    fr: "Le compte d’attente de migration est manquant.",
  },
  {
    en: "This migration step is blocked while production cutover is prepared or active. Use only cutover controls and review mappings.",
    ar: "تم حظر خطوة الترحيل هذه أثناء إعداد التحويل التشغيلي للإنتاج أو نشاطه. استخدم فقط عناصر تحكم التحويل ومراجعة عمليات الربط.",
    fr: "Cette étape de migration est bloquée pendant que le basculement de production est préparé ou actif. Utilisez uniquement les contrôles de basculement et la révision des correspondances.",
  },
  {
    en: "Target contains ${activity.total} genuine non-migration transaction(s).",
    ar: "يحتوي الهدف على {0} معاملة حقيقية ليست من الترحيل.",
    fr: "La cible contient {0} transaction(s) réelle(s) hors migration.",
  },
  {
    en: "Cutover preparation is blocked. Resolve all FAIL items first.",
    ar: "تم حظر إعداد التحويل التشغيلي. عالج جميع عناصر FAIL أولًا.",
    fr: "La préparation du basculement est bloquée. Résolvez d’abord tous les éléments FAIL.",
  },
  {
    en: "Source and target are locked. Review WARN deltas, then finalize to synchronize them.",
    ar: "تم قفل المصدر والهدف. راجع فروقات WARN ثم نفّذ الإنهاء لمزامنتها.",
    fr: "La source et la cible sont verrouillées. Examinez les écarts WARN, puis finalisez pour les synchroniser.",
  },
  {
    en: "Cutover finalization is already running or awaiting recovery.",
    ar: "إنهاء التحويل التشغيلي قيد التشغيل بالفعل أو بانتظار الاسترداد.",
    fr: "La finalisation du basculement est déjà en cours ou en attente de récupération.",
  },
  {
    en: "Final synchronization completed, but verification is not PASS. Both companies remain locked.",
    ar: "اكتملت المزامنة النهائية، لكن نتيجة التحقق ليست PASS. ستبقى الشركتان مقفلتين.",
    fr: "La synchronisation finale est terminée, mais la vérification n’est pas PASS. Les deux sociétés restent verrouillées.",
  },
  {
    en: "Supplier Partner cutover is active and final verification is PASS.",
    ar: "التحويل التشغيلي لشريك المورد نشط ونتيجة التحقق النهائي PASS.",
    fr: "Le basculement du Partenaire fournisseur est actif et la vérification finale est PASS.",
  },
  {
    en: "Rollback is blocked because the Supplier Partner company has genuine post-cutover activity.",
    ar: "تم حظر التراجع لأن شركة شريك المورد لديها نشاط حقيقي بعد التحويل التشغيلي.",
    fr: "L’annulation est bloquée car la société Partenaire fournisseur contient une activité réelle post-basculement.",
  },
  {
    en: "Cutover rolled back. The source is writable again; the target copy remains read-only for safety.",
    ar: "تم التراجع عن التحويل التشغيلي. أصبح المصدر قابلاً للكتابة مجددًا، وتبقى النسخة المستهدفة للقراءة فقط حفاظًا على الأمان.",
    fr: "Le basculement a été annulé. La source est de nouveau modifiable ; la copie cible reste en lecture seule par sécurité.",
  },
  {
    en: "This cutover does not currently hold the target read-only.",
    ar: "هذا التحويل التشغيلي لا يفرض حاليًا وضع القراءة فقط على الهدف.",
    fr: "Ce basculement ne maintient actuellement pas la cible en lecture seule.",
  },
  {
    en: "A newer cutover exists for this target; its state controls the write lock.",
    ar: "يوجد تحويل تشغيلي أحدث لهذا الهدف؛ وحالته هي التي تتحكم في قفل الكتابة.",
    fr: "Un basculement plus récent existe pour cette cible ; son état contrôle le verrou d’écriture.",
  },
  {
    en: "Target hold cannot be released while genuine target transactions exist.",
    ar: "لا يمكن تحرير تعليق الهدف ما دامت هناك معاملات حقيقية في الهدف.",
    fr: "Le blocage de la cible ne peut pas être levé tant que des transactions cibles réelles existent.",
  },
  {
    en: "action must be prepare, finalize, rollback, cancel, or release-target-hold",
    ar: "يجب أن يكون action واحدًا من prepare أو finalize أو rollback أو cancel أو release-target-hold",
    fr: "action doit être prepare, finalize, rollback, cancel ou release-target-hold",
  },
  {
    en: "Cutover activation state changed before the final commit.",
    ar: "تغيّرت حالة تنشيط التحويل التشغيلي قبل الالتزام النهائي.",
    fr: "L’état d’activation du basculement a changé avant la validation finale.",
  },
  {
    en: "Location ${row.locationId} has no safe target mapping.",
    ar: "لا يوجد للموقع {0} ربط آمن بالهدف.",
    fr: "L’emplacement {0} n’a pas de correspondance cible sûre.",
  },
  {
    en: "Cash mapping location ${row.locationId}, account ${row.cashAccountId} has no safe target mapping.",
    ar: "لا يوجد لربط النقد في الموقع {0} والحساب {1} ربط آمن بالهدف.",
    fr: "La correspondance de caisse pour l’emplacement {0}, compte {1}, n’a pas de correspondance cible sûre.",
  },
  {
    en: "${missingVouchers.length} historical sale voucher(s) require migration or provenance repair.",
    ar: "يتطلب {0} سند مبيعات تاريخي ترحيلاً أو إصلاحًا للمصدر.",
    fr: "{0} pièce(s) de vente historique(s) nécessitent une migration ou une réparation de provenance.",
  },
  {
    en: "${missingItems.length} historical sale item row(s) require safe backfill or provenance repair.",
    ar: "يتطلب {0} صف صنف مبيعات تاريخي استكمالاً آمنًا أو إصلاحًا للمصدر.",
    fr: "{0} ligne(s) d’article de vente historique nécessitent un remplissage sûr ou une réparation de provenance.",
  },
  {
    en: "${missingEntries.length} historical accounting entry row(s) require safe backfill or provenance repair.",
    ar: "يتطلب {0} صف قيد محاسبي تاريخي استكمالاً آمنًا أو إصلاحًا للمصدر.",
    fr: "{0} ligne(s) d’écriture comptable historique nécessitent un remplissage sûr ou une réparation de provenance.",
  },
  {
    en: "${unlinkedTargets} target read-only sale voucher(s) have no source provenance and cannot be trusted for cutover.",
    ar: "يوجد {0} سند مبيعات مستهدف للقراءة فقط دون مصدر موثوق، ولا يمكن الاعتماد عليه في التحويل التشغيلي.",
    fr: "{0} pièce(s) de vente cible en lecture seule n’ont aucune provenance source et ne peuvent pas être fiables pour le basculement.",
  },
  {
    en: "${missing.length} source container(s) require migration.",
    ar: "تتطلب {0} حاوية مصدر ترحيلاً.",
    fr: "{0} conteneur(s) source nécessitent une migration.",
  },
  {
    en: "${unresolvedSupplier} migrated container(s) have no resolved supplier link.",
    ar: "يوجد {0} حاوية مرحّلة دون رابط مورد محلول.",
    fr: "{0} conteneur(s) migré(s) n’ont pas de lien fournisseur résolu.",
  },
  {
    en: "${untrackedTargetLines} target container line(s) are not migration-owned and cannot be rebuilt automatically.",
    ar: "يوجد {0} صف حاوية مستهدف لا يملكه الترحيل ولا يمكن إعادة بنائه تلقائيًا.",
    fr: "{0} ligne(s) de conteneur cible ne sont pas détenues par la migration et ne peuvent pas être reconstruites automatiquement.",
  },
  {
    en: "${headerDrift} container header(s) require final synchronization.",
    ar: "يتطلب {0} رأس حاوية مزامنة نهائية.",
    fr: "{0} en-tête(s) de conteneur nécessitent une synchronisation finale.",
  },
  {
    en: "${lineDrift} container line set(s) require final rebuilding.",
    ar: "تتطلب {0} مجموعة صفوف حاوية إعادة بناء نهائية.",
    fr: "{0} ensemble(s) de lignes de conteneur nécessitent une reconstruction finale.",
  },
  {
    en: "${otwStateDrift} container OTW accounting state(s) require final reconciliation.",
    ar: "تتطلب {0} حالة محاسبية لحاوية قيد النقل تسوية نهائية.",
    fr: "{0} état(s) comptable(s) de conteneur en transit nécessitent un rapprochement final.",
  },
  {
    en: "${supplierVoucherGaps} migrated Goods-OTW voucher supplier link(s) remain inconsistent.",
    ar: "لا يزال {0} رابط مورد في سندات البضائع قيد النقل المرحّلة غير متسق.",
    fr: "{0} lien(s) fournisseur de pièces de marchandises en transit migrées restent incohérents.",
  },
  {
    en: "${mismatches.length} user role/location/cash assignment(s) cannot be moved safely.",
    ar: "يتعذر نقل {0} تعيين دور/موقع/نقد للمستخدم بأمان.",
    fr: "{0} affectation(s) rôle/emplacement/caisse utilisateur ne peuvent pas être déplacées en toute sécurité.",
  },
  {
    en: "${inventory.changedRows} target inventory row(s) require exact final synchronization, including ${inventory.targetOnlyRows} target-only row(s).",
    ar: "يتطلب {0} صف مخزون مستهدف مزامنة نهائية دقيقة، بما في ذلك {1} صف موجود في الهدف فقط.",
    fr: "{0} ligne(s) de stock cible nécessitent une synchronisation finale exacte, dont {1} ligne(s) présentes uniquement dans la cible.",
  },
  { en: "periodMonth required (YYYY-MM)", ar: "periodMonth مطلوب (YYYY-MM)", fr: "periodMonth est requis (AAAA-MM)" },
  {
    en: "Profit split for ${req.body.periodMonth} already exists",
    ar: "توزيع الأرباح للفترة {0} موجود بالفعل",
    fr: "La répartition du bénéfice pour {0} existe déjà",
  },
  {
    en: 'Target is missing required accounts: ${missingAccounts.map((row) => row.sub_type).join(", ")}.',
    ar: "يفتقد الهدف الحسابات المطلوبة: {0}.",
    fr: "Les comptes requis suivants manquent dans la cible : {0}.",
  },
  {
    en: "Golden Coast Balance Sheet Accounts",
    ar: "حسابات الميزانية العمومية لغولدن كوست",
    fr: "Comptes du bilan Golden Coast",
  },
  { en: "Action needed", ar: "يلزم اتخاذ إجراء", fr: "Action requise" },
  { en: "Cr GC Sales Cash", ar: "دائن نقدية مبيعات GC", fr: "Crédit Trésorerie ventes GC" },
  {
    en: "Golden Coast accounts provisioned",
    ar: "تم تجهيز حسابات غولدن كوست",
    fr: "Comptes Golden Coast provisionnés",
  },
];
