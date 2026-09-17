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
];
