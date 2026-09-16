import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import type { Phase6ReportsExportsEntry } from "./reportsExportsPhase6TranslationTypes";
import { reportsExportsPhase6TranslationsPart1 } from "./reportsExportsPhase6Translations.part1";
import { reportsExportsPhase6TranslationsPart2 } from "./reportsExportsPhase6Translations.part2";
import { reportsExportsPhase6TranslationsPart3 } from "./reportsExportsPhase6Translations.part3";
import { reportsExportsPhase6TranslationsPart4 } from "./reportsExportsPhase6Translations.part4";
import { reportsExportsPhase6TranslationsPart5 } from "./reportsExportsPhase6Translations.part5";

export const reportsExportsPhase6Translations: readonly Phase6ReportsExportsEntry[] = [
  ...reportsExportsPhase6TranslationsPart1,
  ...reportsExportsPhase6TranslationsPart2,
  ...reportsExportsPhase6TranslationsPart3,
  ...reportsExportsPhase6TranslationsPart4,
  ...reportsExportsPhase6TranslationsPart5,
];

const languages = ["en", "ar", "fr"] as const;
const englishTemplateToken = /\$\{[^}]+\}/g;
const indexedTemplateToken = /\{(\d+)\}/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTemplate(value: string, language: ApplicationLanguage): string {
  if (language !== "en") return value;
  let index = 0;
  return value.replace(englishTemplateToken, () => `{${index++}}`);
}

function hasTemplate(value: string, language: ApplicationLanguage): boolean {
  return language === "en" ? englishTemplateToken.test(value) : indexedTemplateToken.test(value);
}

function resetTemplateRegexes() {
  englishTemplateToken.lastIndex = 0;
  indexedTemplateToken.lastIndex = 0;
}

function templateSpecificity(value: string): number {
  indexedTemplateToken.lastIndex = 0;
  return value.replace(indexedTemplateToken, "").length;
}

type CompiledTemplate = {
  patterns: Record<ApplicationLanguage, RegExp>;
  captureOrder: Record<ApplicationLanguage, readonly number[]>;
  render: Record<ApplicationLanguage, string>;
  specificity: number;
};

function compileLanguageTemplate(
  value: string,
  language: ApplicationLanguage
): { pattern: RegExp; captureOrder: readonly number[] } {
  const normalized = normalizeTemplate(value, language);
  const captureOrder: number[] = [];
  let cursor = 0;
  let source = "^";
  indexedTemplateToken.lastIndex = 0;
  for (const match of normalized.matchAll(indexedTemplateToken)) {
    const offset = match.index ?? 0;
    source += escapeRegex(normalized.slice(cursor, offset));
    source += "(.*?)";
    captureOrder.push(Number(match[1]));
    cursor = offset + match[0].length;
  }
  source += `${escapeRegex(normalized.slice(cursor))}$`;
  return { pattern: new RegExp(source, "u"), captureOrder };
}

const exactEntryByVisibleText = new Map<string, Phase6ReportsExportsEntry>();
const compiledTemplates: CompiledTemplate[] = [];

for (const entry of reportsExportsPhase6Translations) {
  resetTemplateRegexes();
  const dynamic = languages.some((language) => hasTemplate(entry[language], language));
  resetTemplateRegexes();

  if (!dynamic) {
    for (const language of languages) exactEntryByVisibleText.set(entry[language], entry);
    continue;
  }

  const compiledByLanguage = Object.fromEntries(
    languages.map((language) => [language, compileLanguageTemplate(entry[language], language)])
  ) as Record<ApplicationLanguage, { pattern: RegExp; captureOrder: readonly number[] }>;
  const englishRender = normalizeTemplate(entry.en, "en");

  compiledTemplates.push({
    patterns: Object.fromEntries(
      languages.map((language) => [language, compiledByLanguage[language].pattern])
    ) as Record<ApplicationLanguage, RegExp>,
    captureOrder: Object.fromEntries(
      languages.map((language) => [language, compiledByLanguage[language].captureOrder])
    ) as Record<ApplicationLanguage, readonly number[]>,
    render: Object.fromEntries(
      languages.map((language) => [language, normalizeTemplate(entry[language], language)])
    ) as Record<ApplicationLanguage, string>,
    specificity: templateSpecificity(englishRender),
  });
}

compiledTemplates.sort((left, right) => right.specificity - left.specificity);

function renderTemplate(template: string, values: readonly string[]): string {
  indexedTemplateToken.lastIndex = 0;
  return template.replace(indexedTemplateToken, (_token, rawIndex: string) => values[Number(rawIndex)] ?? "");
}

function translateCompiledTemplate(value: string, language: ApplicationLanguage): string | null {
  for (const template of compiledTemplates) {
    for (const sourceLanguage of languages) {
      const match = template.patterns[sourceLanguage].exec(value);
      if (!match) continue;

      const values: string[] = [];
      const order = template.captureOrder[sourceLanguage];
      for (let index = 0; index < order.length; index += 1) {
        values[order[index]] = match[index + 1];
      }
      return renderTemplate(template.render[language], values);
    }
  }
  return null;
}

export function isPhase6ReportsExportsText(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (exactEntryByVisibleText.has(normalized)) return true;
  return compiledTemplates.some((template) =>
    languages.some((language) => template.patterns[language].test(normalized))
  );
}

export function translatePhase6ReportsExportsText(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  if (!normalized) return null;

  const exactEntry = exactEntryByVisibleText.get(normalized);
  const translated = exactEntry?.[language] ?? translateCompiledTemplate(normalized, language);
  return translated === null ? null : `${leading}${translated}${trailing}`;
}
