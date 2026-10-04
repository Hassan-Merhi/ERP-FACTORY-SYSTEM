import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import { createPhase3TemplateTranslator } from "./phase3TemplateTranslationRuntime";
import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

/**
 * EN / AR / FR copy for the retail fashion waves (quick add, barcode labels,
 * scan-to-sell, barcode stock operations, grouped catalog, exchanges and
 * reports). Entries containing `${...}` are template patterns.
 */
export const retailFashionTranslations: readonly Phase3SharedUiEntry[] = [
  // Wave 1 follow-up
  {
    en: "Search style, brand, barcode, SKU, color or size…",
    ar: "ابحث بالموديل أو العلامة أو الباركود أو SKU أو اللون أو المقاس…",
    fr: "Rechercher par modèle, marque, code-barres, SKU, couleur ou taille…",
  },
];

const exactTranslations = new Map<string, Phase3SharedUiEntry>();
for (const entry of retailFashionTranslations) {
  if (!entry.en.includes("${")) exactTranslations.set(entry.en, entry);
}
const templateTranslator = createPhase3TemplateTranslator(retailFashionTranslations);

export function isRetailFashionText(value: string): boolean {
  const normalized = value.trim();
  return exactTranslations.has(normalized) || templateTranslator.matches(normalized);
}

export function translateRetailFashionText(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  const exact = exactTranslations.get(normalized);
  if (exact) return `${leading}${exact[language]}${trailing}`;
  return templateTranslator.translate(value, language, (capture) => capture);
}
