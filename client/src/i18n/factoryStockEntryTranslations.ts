import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

type Translation = Record<ApplicationLanguage, string>;

/**
 * Factory Stock Entry bale-limit messages.
 *
 * The Stock Entry flow caps an entry at two bales and reports that cap from
 * several places — adding a scanned bale, confirming an entry, and raising the
 * quantity on a cart line. Those literals shipped untranslated, so they are
 * collected here and resolved through the application interface translator like
 * every other factory surface.
 */
const translations: Record<string, Translation> = {
  "2-bale limit reached": {
    en: "2-bale limit reached",
    ar: "تم بلوغ حد البالتين",
    fr: "Limite de 2 balles atteinte",
  },
  "Finish this Stock Entry before adding another bale.": {
    en: "Finish this Stock Entry before adding another bale.",
    ar: "أنهِ إدخال المخزون هذا قبل إضافة بالة أخرى.",
    fr: "Terminez cette entrée de stock avant d’ajouter une autre balle.",
  },
  "A Stock Entry can contain at most 2 bales.": {
    en: "A Stock Entry can contain at most 2 bales.",
    ar: "يمكن أن يحتوي إدخال المخزون على بالتين كحد أقصى.",
    fr: "Une entrée de stock peut contenir au maximum 2 balles.",
  },
  "A Stock Entry can contain at most 2 bales. Confirm this entry before adding another.": {
    en: "A Stock Entry can contain at most 2 bales. Confirm this entry before adding another.",
    ar: "يمكن أن يحتوي إدخال المخزون على بالتين كحد أقصى. أكّد هذا الإدخال قبل إضافة بالة أخرى.",
    fr: "Une entrée de stock peut contenir au maximum 2 balles. Confirmez cette entrée avant d’en ajouter une autre.",
  },
  "A Stock Entry can contain at most 2 bales. Reduce the quantity before confirming.": {
    en: "A Stock Entry can contain at most 2 bales. Reduce the quantity before confirming.",
    ar: "يمكن أن يحتوي إدخال المخزون على بالتين كحد أقصى. قلّل الكمية قبل التأكيد.",
    fr: "Une entrée de stock peut contenir au maximum 2 balles. Réduisez la quantité avant de confirmer.",
  },
};

export function translateFactoryStockEntryText(value: string, language: ApplicationLanguage): string | null {
  return translations[value]?.[language] ?? null;
}
