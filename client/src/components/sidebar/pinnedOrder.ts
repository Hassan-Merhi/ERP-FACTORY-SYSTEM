/**
 * Reconcile an existing user's saved sidebar order with the current pinned links.
 * Preserve the user's ordering, append newly introduced links, and discard stale,
 * malformed, or duplicate entries.
 */
export function reconcilePinnedOrder(saved: unknown, defaultUrls: readonly string[]): string[] {
  const allowed = new Set(defaultUrls);
  const seen = new Set<string>();
  const next: string[] = [];

  for (const url of [...(Array.isArray(saved) ? saved : []), ...defaultUrls]) {
    if (typeof url !== "string" || !allowed.has(url) || seen.has(url)) continue;
    seen.add(url);
    next.push(url);
  }

  return next;
}
