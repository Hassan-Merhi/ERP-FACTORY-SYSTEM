import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import { createPhase3TemplateTranslator } from "./phase3TemplateTranslationRuntime";
import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";
import { wave8ReleaseTranslationsPart1 } from "./wave8ReleaseTranslations.part1";
import { wave8ReleaseTranslationsPart2 } from "./wave8ReleaseTranslations.part2";

export const wave8ReleaseTranslations: readonly Phase3SharedUiEntry[] = [
  ...wave8ReleaseTranslationsPart1,
  ...wave8ReleaseTranslationsPart2,
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
