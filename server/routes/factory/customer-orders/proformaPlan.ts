/**
 * Merge proforma articles created after a loading's expected-plan snapshot.
 *
 * Existing per-loading expected quantities remain authoritative (particularly
 * for remaining-only continuation loadings). Only entirely new article codes
 * are supplied from the current master proforma for unfinished loadings.
 * When a loading has a saved snapshot, an article missing from it was likely
 * fulfilled in a prior container. Only master articles CREATED AFTER this
 * loading started may be added back; older articles must stay fulfilled.
 * Finalized/cancelled loadings keep their historical snapshot.
 */
export function mergeNewProformaArticles<T extends {
  article_code?: string | null;
  articleCode?: string | null;
  createdAt?: Date | string | null;
  created_at?: Date | string | null;
}>(
  savedLines: readonly T[],
  masterLines: readonly T[],
  allowNewArticles: boolean,
  loadingCreatedAt?: Date | string | null
): T[] {
  if (savedLines.length === 0) return [...masterLines];
  if (!allowNewArticles) return [...savedLines];

  const normalize = (line: T) => String(line.article_code ?? line.articleCode ?? "").trim().toLowerCase();
  const seen = new Set(savedLines.map(normalize).filter(Boolean));
  const snapshotTime = loadingCreatedAt == null ? null : new Date(loadingCreatedAt).getTime();
  const missing = masterLines.filter((line) => {
    const code = normalize(line);
    if (!code || seen.has(code)) return false;
    if (snapshotTime !== null) {
      // A zero/omitted remaining quantity is not a request for the entire
      // original line again. The timestamp also repairs legacy continuations
      // whose persisted plan omitted already-completed article codes.
      const lineCreatedAt = line.createdAt ?? line.created_at;
      const addedAt = lineCreatedAt == null ? NaN : new Date(lineCreatedAt).getTime();
      if (!Number.isFinite(snapshotTime) || !Number.isFinite(addedAt) || addedAt <= snapshotTime) return false;
    }
    seen.add(code);
    return true;
  });
  return [...savedLines, ...missing];
}
