/**
 * BaleStatusBadge — extracted sub-component.
 *
 * Extracted from BarcodeLookup.tsx during the Phase 4 god-file split.
 */
import { CheckCircle2, AlertCircle, XCircle, ArchiveX, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function BaleStatusBadge({ status }: { status: string }) {
  const map: Record<
    string,
    { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: LucideIcon }
  > = {
    IN_STOCK: { label: "In Stock", variant: "default", icon: CheckCircle2 },
    SOLD: { label: "Sold", variant: "secondary", icon: ArchiveX },
    FINALIZED: { label: "Finalized", variant: "secondary", icon: CheckCircle2 },
    DISPATCHED: { label: "Dispatched", variant: "secondary", icon: XCircle },
    DELETED: { label: "Deleted", variant: "destructive", icon: XCircle },
    REMOVED: { label: "Deleted", variant: "destructive", icon: XCircle },
    PENDING_PRESSING: { label: "Pending Pressing", variant: "outline", icon: AlertCircle },
  };
  const info = map[status] || { label: status, variant: "outline" as const, icon: AlertCircle };
  const Icon = info.icon;
  return (
    <Badge variant={info.variant} className="gap-1" data-testid="badge-bale-status">
      <Icon className="h-3 w-3" />
      {info.label}
    </Badge>
  );
}
