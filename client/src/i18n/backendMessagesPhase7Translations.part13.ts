import type { Phase7BackendMessagesEntry } from "./backendMessagesPhase7TranslationTypes";

/** Backend validation messages added after the Phase 7 audit baseline. */
export const backendMessagesPhase7TranslationsPart13: readonly Phase7BackendMessagesEntry[] = [
  {
    en: "Factory fxRateToUsd for ${ccy} is required.",
    ar: "معدل Factory fxRateToUsd للعملة {0} مطلوب.",
    fr: "Le taux Factory fxRateToUsd pour {0} est requis.",
  },
  {
    en: "Factory fxRateToUsd for ${ccy} must be numeric.",
    ar: "يجب أن يكون معدل Factory fxRateToUsd للعملة {0} رقميًا.",
    fr: "Le taux Factory fxRateToUsd pour {0} doit être numérique.",
  },
  {
    en: "Factory fxRateToUsd for ${ccy} must be a positive finite rate.",
    ar: "يجب أن يكون معدل Factory fxRateToUsd للعملة {0} موجبًا ومحدودًا.",
    fr: "Le taux Factory fxRateToUsd pour {0} doit être positif et fini.",
  },
  {
    en: "clientSaleId must be at most 36 characters",
    ar: "يجب ألا يتجاوز clientSaleId 36 حرفًا",
    fr: "clientSaleId ne doit pas dépasser 36 caractères",
  },
  {
    en: "A watched user is required.",
    ar: "يجب تحديد مستخدم للمشاهدة.",
    fr: "Un utilisateur à surveiller est requis.",
  },
  {
    en: "No company selected.",
    ar: "لم يتم تحديد شركة.",
    fr: "Aucune société sélectionnée.",
  },
  {
    en: "No active screen feed is available for this user in the selected company.",
    ar: "لا توجد مشاركة شاشة نشطة متاحة لهذا المستخدم في الشركة المحددة.",
    fr: "Aucun flux d’écran actif n’est disponible pour cet utilisateur dans la société sélectionnée.",
  },
  {
    en: "Service temporarily unavailable — please retry.",
    ar: "الخدمة غير متوفرة مؤقتًا — يرجى إعادة المحاولة.",
    fr: "Service temporairement indisponible — veuillez réessayer.",
  },
  {
    en: "CSRF token missing or invalid.",
    ar: "رمز CSRF مفقود أو غير صالح.",
    fr: "Jeton CSRF manquant ou invalide.",
  },
  {
    en: "That color is already assigned to another active priority loading.",
    ar: "هذا اللون مخصص بالفعل لعملية تحميل أخرى ذات أولوية نشطة.",
    fr: "Cette couleur est déjà attribuée à un autre chargement prioritaire actif.",
  },
  {
    en: "That priority is already assigned to another active priority loading.",
    ar: "هذه الأولوية مخصصة بالفعل لعملية تحميل أخرى ذات أولوية نشطة.",
    fr: "Cette priorité est déjà attribuée à un autre chargement prioritaire actif.",
  },
  {
    en: "Priority Scan configuration changed at the same time. Please try again.",
    ar: "تم تغيير إعدادات المسح حسب الأولوية في الوقت نفسه. يرجى المحاولة مرة أخرى.",
    fr: "La configuration du scan prioritaire a été modifiée simultanément. Veuillez réessayer.",
  },
  {
    en: "Failed to load Priority Scan configuration.",
    ar: "تعذر تحميل إعدادات المسح حسب الأولوية.",
    fr: "Impossible de charger la configuration du scan prioritaire.",
  },
  {
    en: "Invalid loading id",
    ar: "معرّف التحميل غير صالح",
    fr: "Identifiant de chargement non valide",
  },
  {
    en: "Color is required and must be 64 characters or fewer.",
    ar: "اللون مطلوب ويجب ألا يتجاوز 64 حرفًا.",
    fr: "La couleur est requise et doit contenir au maximum 64 caractères.",
  },
  {
    en: "Priority must be a whole number between 1 and 10000.",
    ar: "يجب أن تكون الأولوية عددًا صحيحًا بين 1 و10000.",
    fr: "La priorité doit être un nombre entier compris entre 1 et 10000.",
  },
  {
    en: "enabled must be true or false.",
    ar: "يجب أن تكون قيمة enabled إما true أو false.",
    fr: "La valeur enabled doit être true ou false.",
  },
  {
    en: "Pending loading not found.",
    ar: "لم يتم العثور على عملية التحميل المعلقة.",
    fr: "Chargement en attente introuvable.",
  },
  {
    en: "Only pending loadings in LOADING status can use Priority Scan.",
    ar: "يمكن فقط لعمليات التحميل المعلقة بحالة LOADING استخدام المسح حسب الأولوية.",
    fr: "Seuls les chargements en attente au statut LOADING peuvent utiliser le scan prioritaire.",
  },
  {
    en: "Link a proforma before enabling Priority Scan for this loading.",
    ar: "اربط فاتورة أولية قبل تفعيل المسح حسب الأولوية لهذا التحميل.",
    fr: "Associez une proforma avant d’activer le scan prioritaire pour ce chargement.",
  },
  {
    en: "Failed to save Priority Scan configuration.",
    ar: "تعذر حفظ إعدادات المسح حسب الأولوية.",
    fr: "Impossible d’enregistrer la configuration du scan prioritaire.",
  },
  {
    en: "Failed to clear Priority Scan configuration.",
    ar: "تعذر مسح إعدادات المسح حسب الأولوية.",
    fr: "Impossible d’effacer la configuration du scan prioritaire.",
  },
];
