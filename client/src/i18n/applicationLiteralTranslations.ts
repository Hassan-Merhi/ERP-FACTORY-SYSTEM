import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import { canonicalEnglishLabels } from "./canonicalEnglishLabels";
import {
  applicationEnglishTranslations,
  getApplicationTranslationCatalogVersion,
  getLoadedApplicationTranslationCatalog,
  translateApplicationText,
  type ApplicationTranslationKey,
} from "./applicationTranslations";

const applicationEntryByVisibleText = new Map<string, ApplicationTranslationKey>();
let indexedCatalogVersion = -1;

function rebuildVisibleTextIndex() {
  applicationEntryByVisibleText.clear();

  const keys = Object.keys(applicationEnglishTranslations) as ApplicationTranslationKey[];
  for (const key of keys) {
    applicationEntryByVisibleText.set(applicationEnglishTranslations[key], key);
  }

  const registerAliases = (language: "ar" | "fr") => {
    const catalog = getLoadedApplicationTranslationCatalog(language);
    if (!catalog) return;

    for (const key of keys) {
      const alias = catalog[key];
      if (!alias || applicationEntryByVisibleText.has(alias)) continue;
      if (alias !== applicationEnglishTranslations[key] && canonicalEnglishLabels.has(alias)) continue;
      applicationEntryByVisibleText.set(alias, key);
    }
  };

  registerAliases("ar");
  registerAliases("fr");
  indexedCatalogVersion = getApplicationTranslationCatalogVersion();
}

function ensureVisibleTextIndex() {
  if (indexedCatalogVersion !== getApplicationTranslationCatalogVersion() || applicationEntryByVisibleText.size === 0) {
    rebuildVisibleTextIndex();
  }
}

export function translateApplicationLiteral(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  if (!normalized) return null;

  ensureVisibleTextIndex();
  const key = applicationEntryByVisibleText.get(normalized);
  return key ? `${leading}${translateApplicationText(key, language)}${trailing}` : null;
}
