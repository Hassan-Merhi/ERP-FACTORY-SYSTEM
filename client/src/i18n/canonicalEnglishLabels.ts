import { sharedInterfaceTranslations } from "./sharedInterfaceTranslations";
import { phase3SharedUiTranslations } from "./sharedUiTranslations";

/**
 * English labels that other dictionaries own canonically.
 *
 * The interface translator matches rendered text against every language of
 * every dictionary so it can convert already-translated text back. That makes
 * spellings shared across languages ambiguous: the French word for "Inventory"
 * is "Stock", which collides with the canonical English "Stock" label used by
 * the inventory nav item. Without this guard the alias wins and the English UI
 * renders two "Inventory" entries in the sidebar.
 *
 * Dictionaries consult this set before registering a non-English alias, so a
 * canonical English label always keeps its own spelling.
 */
export const canonicalEnglishLabels: ReadonlySet<string> = new Set([
  ...sharedInterfaceTranslations.map((entry) => entry.en),
  ...phase3SharedUiTranslations.map((entry) => entry.en),
]);
