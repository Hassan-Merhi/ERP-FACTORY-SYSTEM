import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";
import { phase3SharedUiTranslationsPart1 } from "./sharedUiPhase3Translations.part1";
import { phase3SharedUiTranslationsPart2 } from "./sharedUiPhase3Translations.part2";
import { phase3SharedUiTranslationsPart3 } from "./sharedUiPhase3Translations.part3";
import { phase3SharedUiTranslationsPart4 } from "./sharedUiPhase3Translations.part4";
import { phase3SharedUiTranslationsPart5 } from "./sharedUiPhase3Translations.part5";
import { phase3SharedUiTranslationsPart6 } from "./sharedUiPhase3Translations.part6";
import { phase3SharedUiTranslationsPart7 } from "./sharedUiPhase3Translations.part7";
import { phase3RemainingTranslationsPart01 } from "./phase3RemainingTranslations.part01";
import { phase3RemainingTranslationsPart02 } from "./phase3RemainingTranslations.part02";
import { phase3RemainingTranslationsPart03 } from "./phase3RemainingTranslations.part03";
import { phase3RemainingTranslationsPart04 } from "./phase3RemainingTranslations.part04";
import { phase3RemainingTranslationsPart05 } from "./phase3RemainingTranslations.part05";
import { phase3RemainingTranslationsPart06 } from "./phase3RemainingTranslations.part06";
import { phase3RemainingTranslationsPart07 } from "./phase3RemainingTranslations.part07";
import { phase3RemainingTranslationsPart08 } from "./phase3RemainingTranslations.part08";
import { phase3RemainingTranslationsPart09 } from "./phase3RemainingTranslations.part09";
import { phase3RemainingTranslationsPart10 } from "./phase3RemainingTranslations.part10";
import { phase3RemainingTranslationsPart11 } from "./phase3RemainingTranslations.part11";
import { phase3RemainingTranslationsPart12 } from "./phase3RemainingTranslations.part12";
import { phase3RemainingTranslationsPart13 } from "./phase3RemainingTranslations.part13";
import { phase3RemainingTranslationsPart14 } from "./phase3RemainingTranslations.part14";
import { phase3RemainingTranslationsPart15 } from "./phase3RemainingTranslations.part15";
import { phase3RemainingTranslationsPart16 } from "./phase3RemainingTranslations.part16";
import { phase3RemainingTranslationsPart17 } from "./phase3RemainingTranslations.part17";
import { phase3RemainingTranslationsPart18 } from "./phase3RemainingTranslations.part18";
import { phase3RemainingTranslationsPart19 } from "./phase3RemainingTranslations.part19";
import { phase3RemainingTranslationsPart20 } from "./phase3RemainingTranslations.part20";
import { phase3RemainingTranslationsPart21 } from "./phase3RemainingTranslations.part21";
import { phase3RemainingTranslationsPart22 } from "./phase3RemainingTranslations.part22";
import { phase3RemainingTranslationsPart23 } from "./phase3RemainingTranslations.part23";
import { phase3RemainingTranslationsPart24 } from "./phase3RemainingTranslations.part24";
import { phase3RemainingTranslationsPart25 } from "./phase3RemainingTranslations.part25";
import { phase3RemainingTranslationsPart26 } from "./phase3RemainingTranslations.part26";
import { createPhase3TemplateTranslator } from "./phase3TemplateTranslationRuntime";

export const phase3SharedUiTranslations: readonly Phase3SharedUiEntry[] = [
  ...phase3SharedUiTranslationsPart1,
  ...phase3SharedUiTranslationsPart2,
  ...phase3SharedUiTranslationsPart3,
  ...phase3SharedUiTranslationsPart4,
  ...phase3SharedUiTranslationsPart5,
  ...phase3SharedUiTranslationsPart6,
  ...phase3SharedUiTranslationsPart7,
  ...phase3RemainingTranslationsPart01,
  ...phase3RemainingTranslationsPart02,
  ...phase3RemainingTranslationsPart03,
  ...phase3RemainingTranslationsPart04,
  ...phase3RemainingTranslationsPart05,
  ...phase3RemainingTranslationsPart06,
  ...phase3RemainingTranslationsPart07,
  ...phase3RemainingTranslationsPart08,
  ...phase3RemainingTranslationsPart09,
  ...phase3RemainingTranslationsPart10,
  ...phase3RemainingTranslationsPart11,
  ...phase3RemainingTranslationsPart12,
  ...phase3RemainingTranslationsPart13,
  ...phase3RemainingTranslationsPart14,
  ...phase3RemainingTranslationsPart15,
  ...phase3RemainingTranslationsPart16,
  ...phase3RemainingTranslationsPart17,
  ...phase3RemainingTranslationsPart18,
  ...phase3RemainingTranslationsPart19,
  ...phase3RemainingTranslationsPart20,
  ...phase3RemainingTranslationsPart21,
  ...phase3RemainingTranslationsPart22,
  ...phase3RemainingTranslationsPart23,
  ...phase3RemainingTranslationsPart24,
  ...phase3RemainingTranslationsPart25,
  ...phase3RemainingTranslationsPart26,
];

const canonicalEnglishText = new Set(phase3SharedUiTranslations.map((entry) => entry.en));
const exactEntryByVisibleText = new Map<string, Phase3SharedUiEntry>();
for (const entry of phase3SharedUiTranslations) {
  exactEntryByVisibleText.set(entry.en, entry);
  for (const alias of [entry.ar, entry.fr]) {
    if (/\{\{\d+\}\}/.test(alias)) continue;
    if (alias !== entry.en && canonicalEnglishText.has(alias)) continue;
    if (!exactEntryByVisibleText.has(alias)) exactEntryByVisibleText.set(alias, entry);
  }
}

const generatedTemplateTranslator = createPhase3TemplateTranslator(phase3SharedUiTranslations);

type DynamicCaptures = readonly string[];
type DynamicRule = {
  patterns: Record<ApplicationLanguage, RegExp>;
  render: Record<ApplicationLanguage, (captures: DynamicCaptures) => string>;
};

const dynamicRules: readonly DynamicRule[] = [
  {
    patterns: {
      en: /^You have (\d+) unread messages?\.$/,
      ar: /^لديك (\d+) رسالة غير مقروءة\.$/,
      fr: /^Vous avez (\d+) message\(s\) non lu\(s\)\.$/,
    },
    render: {
      en: ([count]) => `You have ${count} unread message${Number(count) === 1 ? "" : "s"}.`,
      ar: ([count]) => `لديك ${count} رسالة غير مقروءة.`,
      fr: ([count]) => `Vous avez ${count} message(s) non lu(s).`,
    },
  },
  {
    patterns: {
      en: /^(.+) created successfully$/,
      ar: /^تم إنشاء (.+) بنجاح$/,
      fr: /^(.+) créé avec succès$/,
    },
    render: {
      en: ([value]) => `${value} created successfully`,
      ar: ([value]) => `تم إنشاء ${value} بنجاح`,
      fr: ([value]) => `${value} créé avec succès`,
    },
  },
  {
    patterns: {
      en: /^(.+) has been reversed$/,
      ar: /^تم عكس (.+)$/,
      fr: /^(.+) a été contrepassé$/,
    },
    render: {
      en: ([value]) => `${value} has been reversed`,
      ar: ([value]) => `تم عكس ${value}`,
      fr: ([value]) => `${value} a été contrepassé`,
    },
  },
  {
    patterns: {
      en: /^(.+?) kg added to (.+)$/,
      ar: /^تمت إضافة (.+?) كغ إلى (.+)$/,
      fr: /^(.+?) kg ajoutés à (.+)$/,
    },
    render: {
      en: ([weight, batch]) => `${weight} kg added to ${batch}`,
      ar: ([weight, batch]) => `تمت إضافة ${weight} كغ إلى ${batch}`,
      fr: ([weight, batch]) => `${weight} kg ajoutés à ${batch}`,
    },
  },
  {
    patterns: {
      en: /^Only (.+?) kg available in this batch$/,
      ar: /^يتوفر فقط (.+?) كغ في هذه الدفعة$/,
      fr: /^Seulement (.+?) kg disponibles dans ce lot$/,
    },
    render: {
      en: ([weight]) => `Only ${weight} kg available in this batch`,
      ar: ([weight]) => `يتوفر فقط ${weight} كغ في هذه الدفعة`,
      fr: ([weight]) => `Seulement ${weight} kg disponibles dans ce lot`,
    },
  },
  {
    patterns: {
      en: /^You have (.+)\+ actions queued\. Connect to the internet soon to sync\.$/,
      ar: /^لديك (.+)\+ إجراء في قائمة الانتظار\. اتصل بالإنترنت قريبًا للمزامنة\.$/,
      fr: /^Vous avez (.+)\+ actions en attente\. Connectez-vous bientôt à Internet pour synchroniser\.$/,
    },
    render: {
      en: ([count]) => `You have ${count}+ actions queued. Connect to the internet soon to sync.`,
      ar: ([count]) => `لديك ${count}+ إجراء في قائمة الانتظار. اتصل بالإنترنت قريبًا للمزامنة.`,
      fr: ([count]) => `Vous avez ${count}+ actions en attente. Connectez-vous bientôt à Internet pour synchroniser.`,
    },
  },
  {
    patterns: {
      en: /^Please log in again\. Your (.+) pending action\(s\) are saved and will sync after login\.$/,
      ar: /^يرجى تسجيل الدخول مجددًا\. تم حفظ (.+) إجراء معلّق وستتم مزامنته بعد تسجيل الدخول\.$/,
      fr: /^Veuillez vous reconnecter\. Vos (.+) action\(s\) en attente sont enregistrées et seront synchronisées après connexion\.$/,
    },
    render: {
      en: ([count]) => `Please log in again. Your ${count} pending action(s) are saved and will sync after login.`,
      ar: ([count]) => `يرجى تسجيل الدخول مجددًا. تم حفظ ${count} إجراء معلّق وستتم مزامنته بعد تسجيل الدخول.`,
      fr: ([count]) =>
        `Veuillez vous reconnecter. Vos ${count} action(s) en attente sont enregistrées et seront synchronisées après connexion.`,
    },
  },
  {
    patterns: {
      en: /^(.+) action\(s\) synced$/,
      ar: /^تمت مزامنة (.+) إجراء$/,
      fr: /^(.+) action\(s\) synchronisée\(s\)$/,
    },
    render: {
      en: ([count]) => `${count} action(s) synced`,
      ar: ([count]) => `تمت مزامنة ${count} إجراء`,
      fr: ([count]) => `${count} action(s) synchronisée(s)`,
    },
  },
  {
    patterns: {
      en: /^(.+) action\(s\) failed to sync$/,
      ar: /^فشلت مزامنة (.+) إجراء$/,
      fr: /^Échec de synchronisation de (.+) action\(s\)$/,
    },
    render: {
      en: ([count]) => `${count} action(s) failed to sync`,
      ar: ([count]) => `فشلت مزامنة ${count} إجراء`,
      fr: ([count]) => `Échec de synchronisation de ${count} action(s)`,
    },
  },
  {
    patterns: {
      en: /^Mirror voucher (.+) created\.$/,
      ar: /^تم إنشاء السند المقابل (.+)\.$/,
      fr: /^Pièce miroir (.+) créée\.$/,
    },
    render: {
      en: ([voucher]) => `Mirror voucher ${voucher} created.`,
      ar: ([voucher]) => `تم إنشاء السند المقابل ${voucher}.`,
      fr: ([voucher]) => `Pièce miroir ${voucher} créée.`,
    },
  },
  {
    patterns: {
      en: /^Failed \((.+)\)$/,
      ar: /^فشل \((.+)\)$/,
      fr: /^Échec \((.+)\)$/,
    },
    render: {
      en: ([status]) => `Failed (${status})`,
      ar: ([status]) => `فشل (${status})`,
      fr: ([status]) => `Échec (${status})`,
    },
  },
  {
    patterns: {
      en: /^Switched to (.+)$/,
      ar: /^تم التبديل إلى (.+)$/,
      fr: /^Passage à (.+)$/,
    },
    render: {
      en: ([company]) => `Switched to ${company}`,
      ar: ([company]) => `تم التبديل إلى ${company}`,
      fr: ([company]) => `Passage à ${company}`,
    },
  },
];

function findDynamicTranslation(value: string, language: ApplicationLanguage): string | null {
  for (const rule of dynamicRules) {
    for (const sourceLanguage of ["en", "ar", "fr"] as const) {
      const match = value.match(rule.patterns[sourceLanguage]);
      if (match) return rule.render[language](match.slice(1));
    }
  }
  return null;
}

export function isPhase3SharedUiText(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (exactEntryByVisibleText.has(normalized)) return true;
  return (
    dynamicRules.some((rule) =>
      (["en", "ar", "fr"] as const).some((language) => rule.patterns[language].test(normalized))
    ) || generatedTemplateTranslator.matches(normalized)
  );
}

export function translatePhase3SharedUiText(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  if (!normalized) return null;
  const exactEntry = exactEntryByVisibleText.get(normalized);
  const translated =
    exactEntry?.[language] ??
    findDynamicTranslation(normalized, language) ??
    generatedTemplateTranslator.translate(
      normalized,
      language,
      (capture) => exactEntryByVisibleText.get(capture)?.[language] ?? capture
    );
  return translated ? `${leading}${translated}${trailing}` : null;
}
