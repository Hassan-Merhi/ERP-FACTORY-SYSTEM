import { type ReactNode } from "react";
import { CheckCircle2, AlertTriangle, XCircle, Loader2, Info } from "lucide-react";

export function RunStatusBadge({ status }: { status: string }) {
  if (status === "success")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
        <CheckCircle2 className="h-3 w-3" /> Success
      </span>
    );
  if (status === "partial_failed")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 font-medium">
        <AlertTriangle className="h-3 w-3" /> Partial
      </span>
    );
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-destructive font-medium">
        <XCircle className="h-3 w-3" /> Failed
      </span>
    );
  if (status === "running")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 font-medium">
        <Loader2 className="h-3 w-3 animate-spin" /> Running
      </span>
    );
  if (status === "skipped")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground font-medium">
        <Info className="h-3 w-3" /> Skipped
      </span>
    );
  return <span className="text-xs text-muted-foreground">{status}</span>;
}

export function ChannelLine({
  icon,
  label,
  attempted,
  success,
  error,
  attempts,
}: {
  icon: ReactNode;
  label: string;
  attempted?: boolean;
  success?: boolean;
  error?: string;
  attempts?: number;
}) {
  if (!attempted)
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="shrink-0">{icon}</span>
        <span className="font-medium">{label}:</span>
        <span>not attempted</span>
      </div>
    );
  if (success)
    return (
      <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
        <CheckCircle2 className="h-3 w-3 shrink-0" />
        <span className="font-medium">{label}:</span>
        <span>sent{attempts && attempts > 1 ? ` (attempt ${attempts})` : ""}</span>
      </div>
    );
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5 text-xs text-destructive">
        <XCircle className="h-3 w-3 shrink-0" />
        <span className="font-medium">{label}:</span>
        <span>failed{attempts && attempts > 1 ? ` after ${attempts} attempt(s)` : ""}</span>
      </div>
      {error && <p className="text-xs text-muted-foreground pl-5 wrap-break-word">{error}</p>}
    </div>
  );
}

export function StepIcon({ type }: { type: "info" | "success" | "error" | "warning" }) {
  if (type === "success") return <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />;
  if (type === "error") return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />;
  if (type === "warning") return <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />;
  return <Info className="h-3.5 w-3.5 text-blue-500 shrink-0 mt-0.5" />;
}

export function fmtBytes(bytes?: number): string {
  if (!bytes) return "—";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function ReadinessItem({ ok, warn, label }: { ok: boolean; warn?: boolean; label: string }) {
  const icon = ok ? (
    <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400 shrink-0" />
  ) : warn ? (
    <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
  ) : (
    <XCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
  );
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {icon}
      <span className={ok ? "text-foreground" : warn ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>
        {label}
      </span>
    </div>
  );
}
