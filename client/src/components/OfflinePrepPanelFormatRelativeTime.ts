// Extracted from ./OfflinePrepPanel.tsx to keep that module under the source-size cap.
import { Factory, Globe, Shield, ShoppingCart } from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatRelativeTime(ts: number | null): string {
  if (!ts) return "Never";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const PACK_ICONS: Record<string, React.ElementType> = {
  shared: Globe,
  erp: Shield,
  pos: ShoppingCart,
  factory: Factory,
};
