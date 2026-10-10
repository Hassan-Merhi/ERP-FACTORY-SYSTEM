/**
 * StatusPill — extracted sub-component.
 *
 * Extracted from FactoryWorkerAttendanceReport.tsx during the Phase 4 god-file split.
 */
import { cn } from "@/lib/utils";

export /* ── Status Cell ────────────────────────────────────────────────────────────── */
function StatusPill({
  status,
  absentsOnly,
  editable,
  onClick,
  onKeyDown,
}: {
  status?: string;
  absentsOnly?: boolean;
  editable?: boolean;
  onClick?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  if (!status || (absentsOnly && status !== "Absent")) {
    return (
      <span
        tabIndex={editable ? 0 : -1}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={cn(
          "text-muted-foreground/30 text-xs select-none",
          editable &&
            "cursor-pointer hover:text-muted-foreground/60 focus:outline-hidden focus:ring-1 focus:ring-ring rounded-xs"
        )}
      >
        —
      </span>
    );
  }
  if (status === "Present") {
    return (
      <span
        tabIndex={editable ? 0 : -1}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={cn(
          "inline-flex items-center justify-center w-5 h-5 rounded-xs status-success text-[10px] font-bold select-none",
          editable && "cursor-pointer focus:outline-hidden focus:ring-1 focus:ring-ring"
        )}
      >
        P
      </span>
    );
  }
  if (status === "Absent") {
    return (
      <span
        tabIndex={editable ? 0 : -1}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={cn(
          "inline-flex items-center justify-center w-5 h-5 rounded-xs status-danger text-[10px] font-bold select-none",
          editable && "cursor-pointer focus:outline-hidden focus:ring-1 focus:ring-ring"
        )}
      >
        A
      </span>
    );
  }
  if (status === "Leave") {
    return (
      <span
        tabIndex={editable ? 0 : -1}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={cn(
          "inline-flex items-center justify-center w-5 h-5 rounded-xs status-warning text-[10px] font-bold select-none",
          editable && "cursor-pointer focus:outline-hidden focus:ring-1 focus:ring-ring"
        )}
      >
        L
      </span>
    );
  }
  if (status === "HalfDay") {
    return (
      <span
        tabIndex={editable ? 0 : -1}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={cn(
          "inline-flex items-center justify-center w-5 h-5 rounded-xs status-info text-[10px] font-bold select-none",
          editable && "cursor-pointer focus:outline-hidden focus:ring-1 focus:ring-ring"
        )}
      >
        H
      </span>
    );
  }
  return (
    <span
      tabIndex={editable ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex items-center justify-center w-5 h-5 rounded-xs bg-muted text-muted-foreground text-[10px] font-bold select-none",
        editable && "cursor-pointer focus:outline-hidden focus:ring-1 focus:ring-ring"
      )}
    >
      {status.charAt(0)}
    </span>
  );
}

/* ── Main Component ─────────────────────────────────────────────────────────── */
