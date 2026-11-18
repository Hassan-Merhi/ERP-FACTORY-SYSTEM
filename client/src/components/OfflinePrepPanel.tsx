import { OFFLINE_MODE_ENABLED } from "@/lib/featureFlags";
import { OfflinePrepPanelContent } from "./OfflinePrepPanelContent";

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Feature-flag gate. Kept as its own component with no hooks of its own so the
 * early return is legal: the panel below must be able to call its hooks
 * unconditionally. Returning null from here rather than short-circuiting inside
 * the panel also preserves what the flag is for — with the panel unmounted,
 * none of its polling or IndexedDB access is set up at all.
 */
export function OfflinePrepPanel() {
  if (!OFFLINE_MODE_ENABLED) return null;
  return <OfflinePrepPanelContent />;
}
