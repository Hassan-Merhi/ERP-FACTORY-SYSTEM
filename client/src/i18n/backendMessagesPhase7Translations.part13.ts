import type { Phase7BackendMessagesEntry } from "./backendMessagesPhase7TranslationTypes";

/** Factory container FX validation messages added after the Phase 7 audit baseline. */
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
];
