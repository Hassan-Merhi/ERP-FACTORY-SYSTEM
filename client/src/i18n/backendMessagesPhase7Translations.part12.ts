import type { Phase7BackendMessagesEntry } from "./backendMessagesPhase7TranslationTypes";

/** Tenant-scope, parent-accounting, Phase 2 CodeQL parameter-tampering, and intercompany messages. */
export const backendMessagesPhase7TranslationsPart12: readonly Phase7BackendMessagesEntry[] = [
  {
    en: "PO Import company scope does not match the active company.",
    ar: "نطاق شركة استيراد أمر الشراء لا يطابق الشركة النشطة.",
    fr: "Le périmètre de société de l’import du bon de commande ne correspond pas à la société active.",
  },
  {
    en: "Upload company scope does not match the active company.",
    ar: "نطاق شركة الرفع لا يطابق الشركة النشطة.",
    fr: "Le périmètre de société du téléversement ne correspond pas à la société active.",
  },
  {
    en: "The selected parent freight account does not belong to the linked parent company",
    ar: "حساب الشحن الخاص بالشركة الأم المحدد لا ينتمي إلى الشركة الأم المرتبطة",
    fr: "Le compte de fret de la société mère sélectionné n’appartient pas à la société mère liée",
  },
  {
    en: "endDate must be a single YYYY-MM-DD value",
    ar: "يجب أن تكون endDate قيمة واحدة بالتنسيق YYYY-MM-DD",
    fr: "endDate doit être une valeur unique au format YYYY-MM-DD",
  },
  {
    en: "startDate must be a single YYYY-MM-DD value",
    ar: "يجب أن تكون startDate قيمة واحدة بالتنسيق YYYY-MM-DD",
    fr: "startDate doit être une valeur unique au format YYYY-MM-DD",
  },
  {
    en: "lang must be a single string value",
    ar: "يجب أن تكون lang قيمة نصية واحدة",
    fr: "lang doit être une chaîne de caractères unique",
  },
  {
    en: "accountType must be a single string value",
    ar: "يجب أن تكون accountType قيمة نصية واحدة",
    fr: "accountType doit être une chaîne de caractères unique",
  },
  {
    en: "stockItemId must be a single positive integer",
    ar: "يجب أن تكون stockItemId عددًا صحيحًا موجبًا واحدًا",
    fr: "stockItemId doit être un entier positif unique",
  },
  {
    en: "locationId must be a single positive integer",
    ar: "يجب أن تكون locationId عددًا صحيحًا موجبًا واحدًا",
    fr: "locationId doit être un entier positif unique",
  },
  {
    en: "Invalid inventory movement date range",
    ar: "نطاق تاريخ حركة المخزون غير صالح",
    fr: "Plage de dates de mouvement de stock invalide",
  },
  {
    en: "stockItemId, year, month must be single integer values",
    ar: "يجب أن تكون stockItemId وyear وmonth قيمًا صحيحة مفردة",
    fr: "stockItemId, year et month doivent être des valeurs entières uniques",
  },
  {
    en: "year must be a valid four-digit year",
    ar: "يجب أن تكون year سنة صالحة من أربعة أرقام",
    fr: "year doit être une année valide à quatre chiffres",
  },
  {
    en: "month must be between 1 and 12",
    ar: "يجب أن تكون month بين 1 و12",
    fr: "month doit être compris entre 1 et 12",
  },
  {
    en: "fromDate and toDate must each be a single YYYY-MM-DD value",
    ar: "يجب أن تكون كل من fromDate وtoDate قيمة واحدة بالتنسيق YYYY-MM-DD",
    fr: "fromDate et toDate doivent chacun être une valeur unique au format YYYY-MM-DD",
  },
  {
    en: "cashAccountId must be a single positive integer",
    ar: "يجب أن تكون cashAccountId عددًا صحيحًا موجبًا واحدًا",
    fr: "cashAccountId doit être un entier positif unique",
  },
  {
    en: "Configured intercompany credit account ${configuredAccountId} is missing, inactive, or belongs to another company",
    ar: "حساب الائتمان بين الشركات المُكوّن ${configuredAccountId} مفقود أو غير نشط أو ينتمي إلى شركة أخرى",
    fr: "Le compte de crédit intersociétés configuré ${configuredAccountId} est introuvable, inactif ou appartient à une autre société",
  },
  {
    en: "Golden Coast owner-withdrawal clearing account is duplicated",
    ar: "حساب مقاصة سحوبات مالك غولدن كوست مكرر",
    fr: "Le compte de compensation des retraits du propriétaire de Golden Coast est dupliqué",
  },
  {
    en: "${GC_OWNER_WITHDRAWAL_CLEARING_CODE} is already used by another ledger role; repair the chart of accounts first",
    ar: "{0} مستخدم بالفعل لدور آخر في دفتر الأستاذ؛ أصلح دليل الحسابات أولاً",
    fr: "{0} est déjà utilisé par un autre rôle du grand livre ; corrigez d’abord le plan comptable",
  },
  {
    en: "Could not provision Golden Coast owner-withdrawal clearing account",
    ar: "تعذر إنشاء حساب مقاصة سحوبات مالك غولدن كوست",
    fr: "Impossible de créer le compte de compensation des retraits du propriétaire de Golden Coast",
  },
  {
    en: "WhatsApp could not authenticate with any configured Green API instance. Update the WhatsApp Instance ID/API Token in Settings, then try again.",
    ar: "تعذر على واتساب المصادقة مع أي مثيل Green API مُكوّن. حدّث معرّف مثيل واتساب ورمز API في الإعدادات، ثم حاول مرة أخرى.",
    fr: "WhatsApp n’a pu s’authentifier auprès d’aucune instance Green API configurée. Mettez à jour l’identifiant d’instance WhatsApp et le jeton API dans les paramètres, puis réessayez.",
  },
  {
    en: "Container data not found in preview",
    ar: "لم يتم العثور على بيانات الحاوية في المعاينة",
    fr: "Données du conteneur introuvables dans l’aperçu",
  },
  {
    en: "Linked proforma is unavailable. Scan again to bypass.",
    ar: "الفاتورة المبدئية المرتبطة غير متوفرة. امسح مرة أخرى للتجاوز.",
    fr: "La proforma liée est indisponible. Scannez à nouveau pour contourner.",
  },
  {
    // The same message as the ${currentCount}/${proformaLine.quantity} entry in
    // phase3RemainingTranslations.part17; the capacity refactor renamed the
    // placeholders, and the audit matches the source text exactly.
    en: "Quantity exceeded (${decision.consumedQty}/${decision.requestedQty}). Scan again to bypass.",
    ar: "الكمية التي تم تجاوزها{{0}}/{{1}}الشاشة مرة أخرى",
    fr: "Quantité dépassée ({{0}}/{{1}}). Scannez encore pour contourner.",
  },
  {
    en: "Existing loaded bales exceed or do not match the selected proforma capacity",
    ar: "البالات المحمّلة الحالية تتجاوز سعة الفاتورة المبدئية المحددة أو لا تطابقها",
    fr: "Les balles déjà chargées dépassent la capacité de la proforma sélectionnée ou n’y correspondent pas",
  },
  {
    en: "Too many requests. Please slow down and try again shortly.",
    ar: "طلبات كثيرة جدًا. يرجى التمهّل والمحاولة مرة أخرى بعد قليل.",
    fr: "Trop de requêtes. Veuillez ralentir et réessayer dans un instant.",
  },
  {
    // Route-sweep validation messages: the backend answers 400 with these
    // literals instead of letting unvalidated input fail as a 500.
    en: "enabled must be a boolean",
    ar: "يجب أن تكون enabled قيمة منطقية (true أو false)",
    fr: "enabled doit être un booléen",
  },
  {
    en: "date is required and must be a valid date",
    ar: "التاريخ مطلوب ويجب أن يكون تاريخًا صالحًا",
    fr: "La date est requise et doit être une date valide",
  },
  {
    en: "kgWaste is required and must be a number",
    ar: "قيمة kgWaste مطلوبة ويجب أن تكون رقمًا",
    fr: "kgWaste est requis et doit être un nombre",
  },
  {
    en: "templateId is required and must be an integer",
    ar: "معرّف القالب templateId مطلوب ويجب أن يكون عددًا صحيحًا",
    fr: "templateId est requis et doit être un entier",
  },
  {
    en: "Metric not found",
    ar: "لم يتم العثور على المقياس",
    fr: "Métrique introuvable",
  },
  {
    en: "each entry requires an integer metricId",
    ar: "يتطلب كل إدخال metricId عددًا صحيحًا",
    fr: "Chaque entrée requiert un metricId entier",
  },
  {
    en: "date must be a valid date",
    ar: "يجب أن يكون التاريخ تاريخًا صالحًا",
    fr: "La date doit être une date valide",
  },
  {
    en: "availableContainers must be a number",
    ar: "يجب أن تكون availableContainers رقمًا",
    fr: "availableContainers doit être un nombre",
  },
  {
    en: "Invalid archive ID",
    ar: "معرّف الأرشيف غير صالح",
    fr: "Identifiant d’archive non valide",
  },
  {
    en: "${missingVoucherField[0]} is required",
    ar: "الحقل {0} مطلوب",
    fr: "Le champ {0} est requis",
  },
  {
    en: "Attendance WhatsApp Group",
    ar: "مجموعة واتساب للحضور",
    fr: "Groupe WhatsApp de présence",
  },
  {
    en: "This group is used only for Attendance Register images. It does not change production or weekly report groups.",
    ar: "تُستخدم هذه المجموعة فقط لصور سجل الحضور. ولا تغيّر مجموعات الإنتاج أو التقارير الأسبوعية.",
    fr: "Ce groupe est utilisé uniquement pour les images du registre de présence. Il ne modifie pas les groupes de production ni de rapports hebdomadaires.",
  },
  {
    en: "Search WhatsApp groups...",
    ar: "ابحث في مجموعات واتساب...",
    fr: "Rechercher des groupes WhatsApp...",
  },
  {
    en: "No WhatsApp groups found.",
    ar: "لم يتم العثور على مجموعات واتساب.",
    fr: "Aucun groupe WhatsApp trouvé.",
  },
  {
    en: "Could not load factory staff.",
    ar: "تعذر تحميل موظفي المصنع.",
    fr: "Impossible de charger le personnel de l’usine.",
  },
  {
    en: "Attendance WhatsApp group updated",
    ar: "تم تحديث مجموعة واتساب للحضور",
    fr: "Groupe WhatsApp de présence mis à jour",
  },
  {
    en: "Failed to save WhatsApp group",
    ar: "تعذر حفظ مجموعة واتساب",
    fr: "Impossible d’enregistrer le groupe WhatsApp",
  },
  {
    en: "Failed to load WhatsApp groups",
    ar: "تعذر تحميل مجموعات واتساب",
    fr: "Impossible de charger les groupes WhatsApp",
  },
  {
    en: "No Production WhatsApp group configured. Go to Factory Settings → Production WhatsApp Group.",
    ar: "لم يتم إعداد مجموعة واتساب للإنتاج. انتقل إلى إعدادات المصنع ← مجموعة واتساب للإنتاج.",
    fr: "Aucun groupe WhatsApp de production n’est configuré. Accédez à Paramètres de l’usine → Groupe WhatsApp de production.",
  },
  {
    en: "Production WhatsApp credentials are not configured.",
    ar: "بيانات اعتماد واتساب للإنتاج غير مُعدة.",
    fr: "Les identifiants WhatsApp de production ne sont pas configurés.",
  },
  {
    en: "Production WhatsApp sending is disabled.",
    ar: "إرسال واتساب للإنتاج معطّل.",
    fr: "L’envoi WhatsApp de production est désactivé.",
  },
  {
    en: "Production Targets image sent to the configured Production WhatsApp group.",
    ar: "تم إرسال صورة أهداف الإنتاج إلى مجموعة واتساب للإنتاج المُعدة.",
    fr: "L’image des objectifs de production a été envoyée au groupe WhatsApp de production configuré.",
  },
  {
    en: "Loading #${data.id} is separate and ready for scanning",
    ar: "التحميل رقم {0} منفصل وجاهز للمسح",
    fr: "Le chargement n° {0} est séparé et prêt à être scanné",
  },
  {
    en: "Proforma capacity returned for the wrong loading order",
    ar: "تم إرجاع سعة الفاتورة الأولية لطلب تحميل غير صحيح",
    fr: "La capacité de la proforma a été renvoyée pour le mauvais ordre de chargement",
  },
  {
    en: "Only months with movement are shown",
    ar: "يتم عرض الأشهر التي تحتوي على حركة فقط",
    fr: "Seuls les mois comportant des mouvements sont affichés",
  },
  {
    en: "Payroll paid: ${input.workerName} – ${input.netSalary.toFixed(2)} (${input.periodStart} – ${input.periodEnd})",
    ar: "تم دفع الراتب: {0} – {1} ({2} – {3})",
    fr: "Paie versée : {0} – {1} ({2} – {3})",
  },
  {
    en: "cashAccountId is required for non-zero payroll payment",
    ar: "cashAccountId مطلوب لدفعة رواتب غير صفرية",
    fr: "cashAccountId est requis pour un paiement de paie non nul",
  },
  {
    en: "Unable to create Inventory control account for company ${companyId}",
    ar: "تعذر إنشاء حساب مراقبة المخزون للشركة {0}",
    fr: "Impossible de créer le compte de contrôle des stocks pour la société {0}",
  },
  {
    en: "${field} must be finite",
    ar: "يجب أن تكون قيمة {0} عددًا محدودًا",
    fr: "{0} doit être une valeur finie",
  },
  {
    en: "${field} is outside safe accounting range",
    ar: "قيمة {0} خارج النطاق المحاسبي الآمن",
    fr: "{0} est hors de la plage comptable sûre",
  },
  {
    en: "money cents must be a safe integer",
    ar: "يجب أن تكون السنتات مبلغًا صحيحًا آمنًا",
    fr: "Les centimes monétaires doivent être un entier sûr",
  },
  {
    en: "Payroll net salary and advances must not be negative",
    ar: "يجب ألا يكون صافي راتب الرواتب والسلف سالبًا",
    fr: "Le salaire net et les avances de paie ne doivent pas être négatifs",
  },
  {
    en: "Phase 3 could not create ledger ${name} for company ${companyId}",
    ar: "تعذر على المرحلة 3 إنشاء دفتر الأستاذ {0} للشركة {1}",
    fr: "La phase 3 n’a pas pu créer le grand livre {0} pour la société {1}",
  },
  {
    en: "Phase 3 repair left voucher ${voucherId} unbalanced (${row?.debit ?? \"missing\"}/${row?.credit ?? \"missing\"})",
    ar: "ترك إصلاح المرحلة 3 السند {0} غير متوازن ({1}/{2})",
    fr: "La réparation de la phase 3 a laissé la pièce {0} déséquilibrée ({1}/{2})",
  },
  {
    en: "Phase 3 refused duplicate-sale repair: voucher 3000 matched ${bad.rows.length}/4 corrupt entries",
    ar: "رفضت المرحلة 3 إصلاح البيع المكرر: طابق السند 3000 عدد {0}/4 من القيود التالفة",
    fr: "La phase 3 a refusé la réparation de la vente dupliquée : la pièce 3000 correspondait à {0}/4 écritures corrompues",
  },
  {
    en: "Phase 3 refused duplicate-sale repair: the preserved voucher 3000 entries do not equal its source total",
    ar: "رفضت المرحلة 3 إصلاح البيع المكرر: قيود السند 3000 المحفوظة لا تساوي إجمالي المصدر",
    fr: "La phase 3 a refusé la réparation de la vente dupliquée : les écritures conservées de la pièce 3000 ne correspondent pas au total source",
  },
  {
    en: "Phase 3 payroll repair found no source payrolls for ${periodStart}..${periodEnd}",
    ar: "لم يعثر إصلاح الرواتب في المرحلة 3 على رواتب مصدر للفترة {0}..{1}",
    fr: "La réparation de paie de la phase 3 n’a trouvé aucune paie source pour {0}..{1}",
  },
  {
    en: "Phase 3 payroll repair found no existing generation voucher for ${periodStart}..${periodEnd}",
    ar: "لم يعثر إصلاح الرواتب في المرحلة 3 على سند إنشاء موجود للفترة {0}..{1}",
    fr: "La réparation de paie de la phase 3 n’a trouvé aucune pièce de génération existante pour {0}..{1}",
  },
  {
    en: "Phase 3 could not parse payroll period from: ${row.description}",
    ar: "تعذر على المرحلة 3 تحليل فترة الرواتب من: {0}",
    fr: "La phase 3 n’a pas pu analyser la période de paie depuis : {0}",
  },
  {
    en: "Phase 3 historical repair left ${broken.rows.length} true double-entry exception(s) in company ${companyId}:",
    ar: "ترك الإصلاح التاريخي للمرحلة 3 عدد {0} من استثناءات القيد المزدوج الحقيقية في الشركة {1}:",
    fr: "La réparation historique de la phase 3 a laissé {0} exception(s) réelle(s) en partie double dans la société {1} :",
  },
  {
    en: "Phase 3 payroll Daybook repair could not prove ${unresolved.rows.length} payroll mirror(s) in company ${companyId}:",
    ar: "تعذر على إصلاح دفتر اليومية للرواتب في المرحلة 3 إثبات {0} من مرايا الرواتب في الشركة {1}:",
    fr: "La réparation du journal de paie de la phase 3 n’a pas pu valider {0} miroir(s) de paie dans la société {1} :",
  },
  {
    en: "Phase 3 payroll Daybook repair found amount mismatch(es) in company ${companyId}:",
    ar: "وجد إصلاح دفتر اليومية للرواتب في المرحلة 3 اختلافات في المبالغ في الشركة {0}:",
    fr: "La réparation du journal de paie de la phase 3 a trouvé des écarts de montant dans la société {0} :",
  },
];
