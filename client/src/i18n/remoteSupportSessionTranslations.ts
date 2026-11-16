import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import type { Phase7BackendMessagesEntry } from "./backendMessagesPhase7TranslationTypes";

export const remoteSupportPhase4Translations: readonly Phase7BackendMessagesEntry[] = [
  {
    en: "Admin support active",
    ar: "دعم المسؤول نشط",
    fr: "Assistance administrateur active",
  },
  {
    en: "ERP tab only",
    ar: "علامة تبويب ERP فقط",
    fr: "Onglet ERP uniquement",
  },
  {
    en: "Unable to manage the support session.",
    ar: "تعذر إدارة جلسة الدعم.",
    fr: "Impossible de gérer la session d’assistance.",
  },
  {
    en: "A browser tab identifier is required.",
    ar: "معرّف علامة تبويب المتصفح مطلوب.",
    fr: "Un identifiant d’onglet du navigateur est requis.",
  },
  {
    en: "The support session is no longer active.",
    ar: "جلسة الدعم لم تعد نشطة.",
    fr: "La session d’assistance n’est plus active.",
  },
  {
    en: "Support session not found.",
    ar: "لم يتم العثور على جلسة الدعم.",
    fr: "Session d’assistance introuvable.",
  },
  {
    en: "Invalid pointer update.",
    ar: "تحديث المؤشر غير صالح.",
    fr: "Mise à jour du pointeur non valide.",
  },
];

const translationByText = new Map<string, Phase7BackendMessagesEntry>();
for (const entry of remoteSupportPhase4Translations) {
  translationByText.set(entry.en, entry);
  translationByText.set(entry.ar, entry);
  translationByText.set(entry.fr, entry);
}

export function translateRemoteSupportPhase4Text(value: string, language: ApplicationLanguage): string {
  return translationByText.get(value)?.[language] ?? value;
}
