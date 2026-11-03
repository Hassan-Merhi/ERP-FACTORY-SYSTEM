import { CheckCircle, Clock, Users, XCircle } from "lucide-react";
import { SummaryCard } from "./SummaryCard";

/** The four attendance KPI cards: total, present, absent and other. */
export function AttendanceSummaryGrid({
  counts,
}: {
  counts: { total: number; present: number; absent: number; other: number };
}) {
  return (
    <div className="attendance-kpi-grid grid grid-cols-2 gap-3 xl:grid-cols-4">
      <SummaryCard
        icon={<Users className="h-4 w-4" />}
        label="Total"
        value={counts.total}
        color="text-foreground"
        testId="stat-total"
        modern
      />
      <SummaryCard
        icon={<CheckCircle className="h-4 w-4" />}
        label="Present"
        value={counts.present}
        color="text-green-600 dark:text-green-400"
        testId="stat-present"
        modern
      />
      <SummaryCard
        icon={<XCircle className="h-4 w-4" />}
        label="Absent"
        value={counts.absent}
        color="text-red-600 dark:text-red-400"
        testId="stat-absent"
        modern
      />
      <SummaryCard
        icon={<Clock className="h-4 w-4" />}
        label="Other"
        value={counts.other}
        color="text-amber-600 dark:text-amber-400"
        testId="stat-other"
        modern
      />
    </div>
  );
}
