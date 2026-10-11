import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import { createPhase3TemplateTranslator } from "./phase3TemplateTranslationRuntime";
import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";
import { wave8ReleaseTranslationsPart1 } from "./wave8ReleaseTranslations.part1";
import { wave8ReleaseTranslationsPart2 } from "./wave8ReleaseTranslations.part2";
import { wave8ReleaseTranslationsPart3 } from "./wave8ReleaseTranslations.part3";
import { wave8ReleaseTranslationsPart4 } from "./wave8ReleaseTranslations.part4";
import { wave8ReleaseTranslationsPhase23 } from "./wave8ReleaseTranslations.phase23";
import { wave8ReleaseTranslationsPhase28 } from "./wave8ReleaseTranslations.phase28";
import { wave8ReleaseTranslationsPhase26 } from "./wave8ReleaseTranslations.phase26";
import { wave8ReleaseTranslationsPhase27 } from "./wave8ReleaseTranslations.phase27";
import { wave8ReleaseTranslationsOwnerCleanup } from "./wave8ReleaseTranslations.ownerCleanup";
import { wave8ReleaseTranslationsOwnerCleanupSteps } from "./wave8ReleaseTranslations.ownerCleanupSteps";

export const wave8ReleaseTranslations: readonly Phase3SharedUiEntry[] = [
  ...wave8ReleaseTranslationsPart1,
  ...wave8ReleaseTranslationsPart2,
  ...wave8ReleaseTranslationsPart3,
  ...wave8ReleaseTranslationsPart4,
  ...wave8ReleaseTranslationsPhase23,
  ...wave8ReleaseTranslationsPhase28,
  ...wave8ReleaseTranslationsPhase26,
  ...wave8ReleaseTranslationsPhase27,
  ...wave8ReleaseTranslationsOwnerCleanup,
  ...wave8ReleaseTranslationsOwnerCleanupSteps,
];

const exactTranslations = new Map<string, Phase3SharedUiEntry>();
for (const entry of wave8ReleaseTranslations) {
  if (!entry.en.includes("${")) exactTranslations.set(entry.en, entry);
}
const templateTranslator = createPhase3TemplateTranslator(wave8ReleaseTranslations);

export function isWave8ReleaseText(value: string): boolean {
  const normalized = value.trim();
  return exactTranslations.has(normalized) || templateTranslator.matches(normalized);
}

export function translateWave8ReleaseText(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  const exact = exactTranslations.get(normalized);
  if (exact) return `${leading}${exact[language]}${trailing}`;
  return templateTranslator.translate(value, language, (capture) => capture);
}
