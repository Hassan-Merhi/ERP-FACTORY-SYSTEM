/**
 * Merge proforma articles created after a loading's expected-plan snapshot.
 *
 * Existing per-loading expected quantities remain authoritative (particularly
 * for remaining-only continuation loadings). Only entirely new article codes
 * are supplied from the current master proforma for unfinished loadings.
 * Finalized/cancelled loadings keep their historical snapshot.
 */
export function mergeNewProformaArticles<T extends {
  article_code?: string | null;
  articleCode?: string | null;
}>(
  savedLines: readonly T[],
  masterLines: readonly T[],
  allowNewArticles: boolean
): T[] {
  if (savedLines.length === 0) return [...masterLines];
  if (!allowNewArticles) return [...savedLines];

  const normalize = (line: T) => String(line.article_code ?? line.articleCode ?? "").trim().toLowerCase();
  const seen = new Set(savedLines.map(normalize).filter(Boolean));
  const missing = masterLines.filter((line) => {
    const code = normalize(line);
    if (!code || seen.has(code)) return false;
    seen.add(code);
    return true;
  });
  return [...savedLines, ...missing];
}
