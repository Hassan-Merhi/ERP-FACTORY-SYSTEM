/**
 * Phase 4 proforma-capacity reconciliation copy.
 *
 * The capacity reconciliation added a small set of user-facing strings to the
 * factory and customer container-loading scan surfaces: the combined
 * loaded-quantity column, the "nothing left to load" guard toast, the capacity
 * fetch failure, and the backend validation message the client surfaces when a
 * capacity request carries a malformed current order id. They are registered
 * here so the interface translator renders them in the active language.
 */
import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

type Entry = Record<ApplicationLanguage, string>;

const entries: Entry[] = [
  // Proforma progress tables: quantity loaded on this container plus every other
  // container already consuming the same proforma.
  {
    en: "Loaded (This+Other)",
    ar: "المحمّل (هذه + أخرى)",
    fr: "Chargé (celui-ci + autres)",
  },
  // Start-loading guard shown when the proforma has no remaining capacity.
  {
    en: "Proforma fully consumed",
    ar: "تم استهلاك البروفورما بالكامل",
    fr: "Proforma entièrement consommé",
  },
  {
    en: "No remaining quantity is available for a new loading.",
    ar: "لا توجد كمية متبقية متاحة لتحميل جديد.",
    fr: "Aucune quantité restante n’est disponible pour un nouveau chargement.",
  },
  // Capacity snapshot request failures.
  {
    en: "Failed to fetch proforma capacity",
    ar: "تعذر جلب سعة البروفورما",
    fr: "Échec de la récupération de la capacité du proforma",
  },
  {
    en: "Invalid currentOrderId",
    ar: "معرّف الطلب الحالي غير صالح",
    fr: "Identifiant de commande actuel invalide",
  },
];

const byVisibleText = new Map<string, Entry>();
for (const entry of entries) {
  byVisibleText.set(entry.en.toLowerCase(), entry);
  byVisibleText.set(entry.ar.toLowerCase(), entry);
  byVisibleText.set(entry.fr.toLowerCase(), entry);
}

export function translateProformaCapacityPhase4Text(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  if (!normalized) return null;

  const entry = byVisibleText.get(normalized.toLowerCase());
  return entry ? `${leading}${entry[language]}${trailing}` : null;
}
