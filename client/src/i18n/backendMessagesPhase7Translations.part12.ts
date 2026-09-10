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
];
