import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CheckCircle2, XCircle, AlertTriangle, Clock, CircleDot, Pause, Loader2, type LucideIcon } from "lucide-react";

export type StatusKind =
  | "active"
  | "inactive"
  | "draft"
  | "pending"
  | "approved"
  | "rejected"
  | "completed"
  | "in_progress"
  | "cancelled"
  | "paid"
  | "unpaid"
  | "overdue"
  | "available"
  | "low_stock"
  | "out_of_stock"
  | "rented"
  | "occupied"
  | "vacant"
  | "success"
  | "warning"
  | "error"
  | "critical"
  | "verified"
  | "finalized"
  | "info"
  | "in_stock"
  | "loading"
  | "loaded"
  | "sold"
  | "reserved_for_order"
  | "label_printed"
  | "open"
  | "running"
  | "failed"
  | "rolled_back"
  | "needs_setup"
  | "disabled"
  | "gaining"
  | "losing"
  | "break_even"
  | "no_data"
  | "partial"
  | "hold"
  | "superseded"
  | "pending_pressing"
  | "pressed"
  | "reserved"
  | "pending_verification"
  | "otw"
  | "in_transit"
  | "arrived"
  | "offloaded"
  | "closed"
  | "dispatched"
  | "repacked"
  | "removed"
  | "deleted"
  | "neutral";

interface StatusMeta {
  label: string;
  variant: "success" | "warning" | "info" | "destructive" | "muted" | "secondary" | "outline";
  icon?: LucideIcon;
}

const STATUS_MAP: Record<StatusKind, StatusMeta> = {
  active: { label: "Active", variant: "success", icon: CheckCircle2 },
  inactive: { label: "Inactive", variant: "muted", icon: CircleDot },
  draft: { label: "Draft", variant: "secondary", icon: Pause },
  pending: { label: "Pending", variant: "warning", icon: Clock },
  approved: { label: "Approved", variant: "success", icon: CheckCircle2 },
  rejected: { label: "Rejected", variant: "destructive", icon: XCircle },
  completed: { label: "Completed", variant: "success", icon: CheckCircle2 },
  in_progress: { label: "In Progress", variant: "info", icon: Loader2 },
  cancelled: { label: "Cancelled", variant: "muted", icon: XCircle },
  paid: { label: "Paid", variant: "success", icon: CheckCircle2 },
  unpaid: { label: "Unpaid", variant: "warning", icon: AlertTriangle },
  overdue: { label: "Overdue", variant: "destructive", icon: AlertTriangle },
  available: { label: "Available", variant: "success", icon: CheckCircle2 },
  low_stock: { label: "Low Stock", variant: "warning", icon: AlertTriangle },
  out_of_stock: { label: "Out of Stock", variant: "destructive", icon: XCircle },
  rented: { label: "Rented", variant: "info", icon: CheckCircle2 },
  occupied: { label: "Occupied", variant: "info", icon: CheckCircle2 },
  vacant: { label: "Vacant", variant: "muted", icon: CircleDot },
  success: { label: "Success", variant: "success", icon: CheckCircle2 },
  warning: { label: "Warning", variant: "warning", icon: AlertTriangle },
  error: { label: "Error", variant: "destructive", icon: XCircle },
  critical: { label: "Critical", variant: "destructive", icon: AlertTriangle },
  verified: { label: "Verified", variant: "success", icon: CheckCircle2 },
  finalized: { label: "Finalized", variant: "info", icon: CheckCircle2 },
  info: { label: "Info", variant: "info", icon: CircleDot },
  // Cross-module statuses: one semantic palette, not one hard-coded color per screen.
  in_stock: { label: "In Stock", variant: "success", icon: CheckCircle2 },
  loading: { label: "Loading", variant: "warning", icon: Clock },
  loaded: { label: "Loaded", variant: "warning", icon: Clock },
  sold: { label: "Sold", variant: "destructive", icon: XCircle },
  reserved_for_order: { label: "Reserved", variant: "info", icon: Clock },
  label_printed: { label: "Label Printed", variant: "outline", icon: CheckCircle2 },
  open: { label: "Open", variant: "info", icon: CircleDot },
  running: { label: "Running", variant: "info", icon: Loader2 },
  failed: { label: "Failed", variant: "destructive", icon: XCircle },
  rolled_back: { label: "Rolled Back", variant: "muted", icon: CircleDot },
  needs_setup: { label: "Needs Setup", variant: "warning", icon: AlertTriangle },
  disabled: { label: "Disabled", variant: "muted", icon: CircleDot },
  gaining: { label: "Gaining", variant: "success", icon: CheckCircle2 },
  losing: { label: "Losing", variant: "destructive", icon: XCircle },
  break_even: { label: "Break Even", variant: "info", icon: CircleDot },
  no_data: { label: "No Data", variant: "warning", icon: AlertTriangle },
  partial: { label: "Partial", variant: "warning", icon: Clock },
  hold: { label: "Hold", variant: "warning", icon: Clock },
  superseded: { label: "Superseded", variant: "muted", icon: CircleDot },
  pending_pressing: { label: "Pending Pressing", variant: "warning", icon: Clock },
  pressed: { label: "Pressed", variant: "info", icon: CheckCircle2 },
  reserved: { label: "Reserved", variant: "info", icon: Clock },
  pending_verification: { label: "Pending Verification", variant: "warning", icon: Clock },
  // Container transport: on the way -> arrived (awaiting offload) -> offloaded.
  otw: { label: "On the Way", variant: "info", icon: Clock },
  in_transit: { label: "In Transit", variant: "info", icon: Clock },
  arrived: { label: "Arrived", variant: "warning", icon: CircleDot },
  offloaded: { label: "Offloaded", variant: "success", icon: CheckCircle2 },
  closed: { label: "Closed", variant: "success", icon: CheckCircle2 },
  // Bale lifecycle tail: dispatched out, repacked into another bale, or removed.
  dispatched: { label: "Dispatched", variant: "warning", icon: Clock },
  repacked: { label: "Repacked", variant: "secondary", icon: CircleDot },
  removed: { label: "Removed", variant: "destructive", icon: XCircle },
  deleted: { label: "Deleted", variant: "destructive", icon: XCircle },
  neutral: { label: "—", variant: "muted", icon: CircleDot },
};

export interface StatusBadgeProps {
  status: StatusKind | string;
  label?: string;
  showIcon?: boolean;
  className?: string;
  "data-testid"?: string;
}

/**
 * StatusBadge — canonical pill for entity status across the app. Maps domain
 * statuses to consistent colors and optional icons.
 */
export function StatusBadge({ status, label, showIcon = true, className, "data-testid": testId }: StatusBadgeProps) {
  const key = String(status).toLowerCase().replace(/[\s-]/g, "_") as StatusKind;
  const meta = STATUS_MAP[key] ?? { label: String(status), variant: "muted" as const };
  const Icon = meta.icon;
  const text = label ?? meta.label;
  return (
    <Badge variant={meta.variant} className={cn("gap-1", className)} data-testid={testId ?? `badge-status-${key}`}>
      {showIcon && Icon && (
        <Icon
          className={cn(
            "h-3 w-3",
            (key === "in_progress" || key === "running") && "animate-spin motion-reduce:animate-none"
          )}
          aria-hidden="true"
        />
      )}
      {text}
    </Badge>
  );
}
