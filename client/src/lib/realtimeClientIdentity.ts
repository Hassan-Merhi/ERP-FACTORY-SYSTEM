let realtimeClientId: string | null = null;

function fallbackRealtimeClientId(): string {
  return `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Identifies one loaded browser tab/page session so the server can avoid
 * echoing a realtime invalidation back to the exact tab that already applied
 * an optimistic/local mutation patch.
 *
 * This is not an auth/security identifier. A new page load intentionally gets
 * a fresh id; other tabs and devices keep receiving realtime invalidations.
 */
export function getRealtimeClientId(): string {
  if (realtimeClientId) return realtimeClientId;
  const generated =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : fallbackRealtimeClientId();
  realtimeClientId = generated;
  return generated;
}
