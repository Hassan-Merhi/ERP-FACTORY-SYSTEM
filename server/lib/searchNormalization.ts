import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { normalizeSearchText } from "@shared/searchNormalization";

/**
 * Server-side companion to normalizeSearchText.
 *
 * Keep the normal ILIKE branch for natural-language searches, then add a compact
 * comparison that removes punctuation/separators from stored values so codes and
 * identifiers still match when the user types them without dots, spaces, hyphens,
 * slashes, underscores, parentheses, etc.
 */
export function punctuationInsensitiveSearch(column: SQLWrapper, search: string): SQL {
  const raw = search.trim();
  const compact = normalizeSearchText(raw);

  if (!compact) {
    return sql`${column} ILIKE ${`%${raw}%`}`;
  }

  return sql`(
    ${column} ILIKE ${`%${raw}%`}
    OR regexp_replace(lower(coalesce(${column}::text, '')), '[^[:alnum:]]+', '', 'g') LIKE ${`%${compact}%`}
  )`;
}
