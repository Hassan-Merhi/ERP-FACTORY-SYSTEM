type ForceToken = symbol;

const queuedForcedReads = new Map<string, Set<ForceToken>>();

function normalizeRequestKey(requestUrl: string): string {
  const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const url = new URL(requestUrl, base);
  return `${url.pathname}${url.search}`;
}

/**
 * Queue exactly one cache-bypassing GET for the supplied API URL.
 *
 * Tokens are caller-owned rather than counted globally so cleanup from one
 * cancelled refetch cannot consume another caller's queued forced read.
 */
export function queueForcedApiRead(requestUrl: string): () => void {
  const key = normalizeRequestKey(requestUrl);
  const token = Symbol(key);
  const tokens = queuedForcedReads.get(key) ?? new Set<ForceToken>();
  tokens.add(token);
  queuedForcedReads.set(key, tokens);

  return () => {
    const current = queuedForcedReads.get(key);
    if (!current) return;
    current.delete(token);
    if (current.size === 0) queuedForcedReads.delete(key);
  };
}

/** Called only by the request-storm guard immediately before issuing a GET. */
export function consumeForcedApiRead(url: URL): boolean {
  const key = `${url.pathname}${url.search}`;
  const tokens = queuedForcedReads.get(key);
  if (!tokens || tokens.size === 0) return false;

  const token = tokens.values().next().value as ForceToken | undefined;
  if (token) tokens.delete(token);
  if (tokens.size === 0) queuedForcedReads.delete(key);
  return true;
}

/**
 * Run an existing React Query refetch as a true server refresh.
 * Normal polling, realtime invalidations and remounts remain cache-friendly.
 */
export async function forceQueryRefetch<T>(requestUrl: string, refetch: () => Promise<T>): Promise<T> {
  const cancelQueuedRead = queueForcedApiRead(requestUrl);
  try {
    return await refetch();
  } finally {
    cancelQueuedRead();
  }
}
