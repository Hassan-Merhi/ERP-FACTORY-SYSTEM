/**
 * Count literal identifier occurrences using the report's existing ASCII
 * identifier-boundary semantics. No user-derived regular expression is built.
 *
 * This intentionally counts text occurrences (including comments and strings)
 * just like the dead-code lead report, rather than changing report semantics
 * to a TypeScript reference analysis.
 */
const IDENTIFIER_PART = /[\w$]/;

export function countStandaloneIdentifierOccurrences(source, identifier) {
  if (typeof source !== "string" || typeof identifier !== "string" || identifier.length === 0) return 0;

  let count = 0;
  let offset = 0;
  while (offset < source.length) {
    const index = source.indexOf(identifier, offset);
    if (index === -1) break;

    const previous = index > 0 ? source[index - 1] : "";
    const following = source[index + identifier.length] ?? "";
    if ((!previous || !IDENTIFIER_PART.test(previous)) && (!following || !IDENTIFIER_PART.test(following))) {
      count++;
    }

    offset = index + identifier.length;
  }
  return count;
}
