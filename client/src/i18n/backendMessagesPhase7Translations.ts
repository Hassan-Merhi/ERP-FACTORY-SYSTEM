import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import type { Phase7BackendMessagesEntry } from "./backendMessagesPhase7TranslationTypes";
import { backendMessagesPhase7TranslationsPart1 } from "./backendMessagesPhase7Translations.part1";
import { backendMessagesPhase7TranslationsPart2 } from "./backendMessagesPhase7Translations.part2";
import { backendMessagesPhase7TranslationsPart3 } from "./backendMessagesPhase7Translations.part3";
import { backendMessagesPhase7TranslationsPart4 } from "./backendMessagesPhase7Translations.part4";
import { backendMessagesPhase7TranslationsPart5 } from "./backendMessagesPhase7Translations.part5";
import { backendMessagesPhase7TranslationsPart6 } from "./backendMessagesPhase7Translations.part6";
import { backendMessagesPhase7TranslationsPart7 } from "./backendMessagesPhase7Translations.part7";
import { backendMessagesPhase7TranslationsPart8 } from "./backendMessagesPhase7Translations.part8";
import { backendMessagesPhase7TranslationsPart9 } from "./backendMessagesPhase7Translations.part9";
import { backendMessagesPhase7TranslationsPart10 } from "./backendMessagesPhase7Translations.part10";
import { backendMessagesPhase7TranslationsPart11 } from "./backendMessagesPhase7Translations.part11";
import { backendMessagesPhase7TranslationsPart12 } from "./backendMessagesPhase7Translations.part12";
import { backendMessagesPhase7TranslationsPart13 } from "./backendMessagesPhase7Translations.part13";

export const backendMessagesPhase7Translations: readonly Phase7BackendMessagesEntry[] = [
  ...backendMessagesPhase7TranslationsPart1,
  ...backendMessagesPhase7TranslationsPart2,
  ...backendMessagesPhase7TranslationsPart3,
  ...backendMessagesPhase7TranslationsPart4,
  ...backendMessagesPhase7TranslationsPart5,
  ...backendMessagesPhase7TranslationsPart6,
  ...backendMessagesPhase7TranslationsPart7,
  ...backendMessagesPhase7TranslationsPart8,
  ...backendMessagesPhase7TranslationsPart9,
  ...backendMessagesPhase7TranslationsPart10,
  ...backendMessagesPhase7TranslationsPart11,
  ...backendMessagesPhase7TranslationsPart12,
  ...backendMessagesPhase7TranslationsPart13,
];

const languages = ["en", "ar", "fr"] as const;
const englishTemplateToken = /\$\{[^}]+\}/g;
const indexedTemplateToken = /\{(\d+)\}/g;
const MAX_NESTED_CAPTURE_DEPTH = 2;

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

function hasTranslatableStaticText(value: string): boolean {
  indexedTemplateToken.lastIndex = 0;
  const staticText = value.replace(indexedTemplateToken, "");
  indexedTemplateToken.lastIndex = 0;
  const placeholderCount = Array.from(value.matchAll(indexedTemplateToken)).length;
  return /[\p{L}\p{N}]/u.test(staticText) || (placeholderCount >= 2 && staticText.includes("→"));
}

type CompiledTemplate = {
  patterns: Record<ApplicationLanguage, RegExp>;
  captureOrder: Record<ApplicationLanguage, readonly number[]>;
  adjacentRuns: Record<ApplicationLanguage, readonly (readonly number[])[]>;
  render: Record<ApplicationLanguage, string>;
  specificity: number;
};

function compileLanguageTemplate(
  value: string,
  language: ApplicationLanguage
): { pattern: RegExp; captureOrder: readonly number[]; adjacentRuns: readonly (readonly number[])[] } {
  const normalized = normalizeTemplate(value, language);
  const captureOrder: number[] = [];
  // Placeholders with no static text between them compile to adjacent lazy groups, which the regex
  // engine cannot split meaningfully — the earlier group always wins empty. Record those runs so a
  // match can redistribute the combined text across them afterwards.
  const adjacentRuns: number[][] = [];
  let cursor = 0;
  let source = "^";
  let position = 0;
  indexedTemplateToken.lastIndex = 0;
  for (const match of normalized.matchAll(indexedTemplateToken)) {
    const offset = match.index ?? 0;
    const staticText = normalized.slice(cursor, offset);
    source += escapeRegex(staticText);
    source += "(.*?)";
    captureOrder.push(Number(match[1]));
    if (position > 0 && staticText === "") {
      const openRun = adjacentRuns[adjacentRuns.length - 1];
      if (openRun && openRun[openRun.length - 1] === position - 1) openRun.push(position);
      else adjacentRuns.push([position - 1, position]);
    }
    cursor = offset + match[0].length;
    position += 1;
  }
  source += `${escapeRegex(normalized.slice(cursor))}$`;
  return { pattern: new RegExp(source, "u"), captureOrder, adjacentRuns };
}

const exactEntryByVisibleText = new Map<string, Phase7BackendMessagesEntry>();
const compiledTemplates: CompiledTemplate[] = [];

for (const entry of backendMessagesPhase7Translations) {
  resetTemplateRegexes();
  const dynamic = languages.some((language) => hasTemplate(entry[language], language));
  resetTemplateRegexes();

  if (!dynamic) {
    for (const language of languages) exactEntryByVisibleText.set(entry[language], entry);
    continue;
  }

  const englishRender = normalizeTemplate(entry.en, "en");
  if (!hasTranslatableStaticText(englishRender)) continue;

  const compiledByLanguage = Object.fromEntries(
    languages.map((language) => [language, compileLanguageTemplate(entry[language], language)])
  ) as Record<
    ApplicationLanguage,
    { pattern: RegExp; captureOrder: readonly number[]; adjacentRuns: readonly (readonly number[])[] }
  >;

  compiledTemplates.push({
    patterns: Object.fromEntries(
      languages.map((language) => [language, compiledByLanguage[language].pattern])
    ) as Record<ApplicationLanguage, RegExp>,
    captureOrder: Object.fromEntries(
      languages.map((language) => [language, compiledByLanguage[language].captureOrder])
    ) as Record<ApplicationLanguage, readonly number[]>,
    adjacentRuns: Object.fromEntries(
      languages.map((language) => [language, compiledByLanguage[language].adjacentRuns])
    ) as Record<ApplicationLanguage, readonly (readonly number[])[]>,
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

function translateNormalizedValue(value: string, language: ApplicationLanguage, depth: number): string | null {
  const exactEntry = exactEntryByVisibleText.get(value);
  return exactEntry?.[language] ?? translateCompiledTemplate(value, language, depth);
}

function translateCapturedValue(value: string, language: ApplicationLanguage, depth: number): string {
  if (depth >= MAX_NESTED_CAPTURE_DEPTH) return value;
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  if (!normalized) return value;
  const translated = translateNormalizedValue(normalized, language, depth + 1);
  return translated === null ? value : `${leading}${translated}${trailing}`;
}

const MAX_ADJACENT_SPLIT_LENGTH = 200;

/**
 * Redistribute the text captured by a run of adjacent placeholders.
 *
 * `${rangeLabel}${skippedNote}` compiles to `(.*?)(.*?)`, so the engine hands the first group an
 * empty string and lets the second swallow "(start → today) (1 skipped)" whole — which then matches
 * the "(… skipped)" template and renders the range untranslated inside an otherwise French message.
 *
 * Try every way of cutting the combined text into `count` pieces and keep the arrangement where the
 * most non-empty pieces are independently translatable. Two real fragments beat one mangled one, so
 * the range and the skipped note each land in their own placeholder.
 */
function splitAdjacentCaptures(
  combined: string,
  count: number,
  language: ApplicationLanguage,
  depth: number
): string[] {
  if (count < 2 || !combined) return Array.from({ length: count }, (_, index) => (index === count - 1 ? combined : ""));
  if (combined.length > MAX_ADJACENT_SPLIT_LENGTH) {
    return Array.from({ length: count }, (_, index) => (index === count - 1 ? combined : ""));
  }

  let bestParts: string[] | null = null;
  let bestScore = -1;

  const walk = (rest: string, remaining: number, parts: string[]) => {
    if (remaining === 1) {
      const candidate = [...parts, rest];
      let score = 0;
      for (const part of candidate) {
        const normalized = part.trim();
        if (!normalized) continue;
        if (translateNormalizedValue(normalized, language, depth + 1) !== null) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestParts = candidate;
      }
      return;
    }
    for (let cut = 0; cut <= rest.length; cut += 1) {
      walk(rest.slice(cut), remaining - 1, [...parts, rest.slice(0, cut)]);
    }
  };

  walk(combined, count, []);
  return bestParts ?? Array.from({ length: count }, (_, index) => (index === count - 1 ? combined : ""));
}

function translateCompiledTemplate(value: string, language: ApplicationLanguage, depth = 0): string | null {
  for (const template of compiledTemplates) {
    for (const sourceLanguage of languages) {
      const match = template.patterns[sourceLanguage].exec(value);
      if (!match) continue;

      const order = template.captureOrder[sourceLanguage];
      const capturedByPosition = order.map((_entry, index) => match[index + 1] ?? "");
      for (const run of template.adjacentRuns[sourceLanguage]) {
        const combined = run.map((position) => capturedByPosition[position]).join("");
        const parts = splitAdjacentCaptures(combined, run.length, language, depth);
        run.forEach((position, partIndex) => {
          capturedByPosition[position] = parts[partIndex];
        });
      }

      const values: string[] = [];
      for (let index = 0; index < order.length; index += 1) {
        values[order[index]] = translateCapturedValue(capturedByPosition[index], language, depth);
      }
      return renderTemplate(template.render[language], values);
    }
  }
  return null;
}

export function isPhase7BackendMessageText(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (exactEntryByVisibleText.has(normalized)) return true;
  return compiledTemplates.some((template) =>
    languages.some((language) => template.patterns[language].test(normalized))
  );
}

export function translatePhase7BackendMessageText(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  if (!normalized) return null;

  const translated = translateNormalizedValue(normalized, language, 0);
  return translated === null ? null : `${leading}${translated}${trailing}`;
}
