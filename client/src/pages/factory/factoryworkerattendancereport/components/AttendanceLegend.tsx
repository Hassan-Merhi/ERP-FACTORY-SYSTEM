/**
 * AttendanceLegend — extracted presentational sub-component.
 *
 * Extracted from FactoryWorkerAttendanceReport.tsx during the god-file split.
 */
import { Badge } from "@/components/ui/badge";

export function AttendanceLegend() {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-white/70 px-4 py-3 text-xs text-muted-foreground dark:border-blue-900/50 dark:bg-[#111f36]/80 print:hidden">
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-xs bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-[11px] font-bold">
          P
        </span>
        Present
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-xs bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 text-[11px] font-bold">
          A
        </span>
        Absent
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground/40">—</span>
        Not recorded
      </span>
      <span className="flex items-center gap-1.5">
        <Badge
          variant="outline"
          className="text-[11px] text-amber-600 dark:text-amber-400 border-amber-300 px-1 py-0 h-auto"
        >
          Sa/Su
        </Badge>
        Weekend
      </span>
    </div>
  );
}
