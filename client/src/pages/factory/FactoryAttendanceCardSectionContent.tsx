// Extracted from ./FactoryAttendanceCardSection.tsx
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AttendanceStatus } from "./factoryattendance/types";
import { STATUS_COLORS, STATUS_OPTIONS } from "./factoryattendance/utils";
import { useFactoryAttendanceState } from "./useFactoryAttendanceStatePart2";

export function FactoryAttendanceCardSectionContent({
  attendanceMap,
  notesMap,
  setNotes,
  setStatus,
  visibleWorkers,
  workers,
}: Pick<
  Pick<
    ReturnType<typeof useFactoryAttendanceState>,
    | "attendanceMap"
    | "attendancePct"
    | "counts"
    | "handleSave"
    | "isLoading"
    | "notesMap"
    | "recordChanges"
    | "saveMutation"
    | "selectedDate"
    | "setNotes"
    | "setStatus"
    | "setStatusFilter"
    | "setWorkerSearch"
    | "statusFilter"
    | "visibleWorkers"
    | "workerSearch"
    | "workers"
  >,
  "attendanceMap" | "notesMap" | "setNotes" | "setStatus" | "visibleWorkers" | "workers"
>) {
  return (
    <>
      {/* Desktop table */}
      <div className="attendance-table-scroll hidden overflow-x-auto sm:block">
        <table className="attendance-table w-full text-sm">
          <thead className="sticky top-0 z-30 bg-muted">
            <tr className="border-b border-border/60">
              <th className="text-left px-4 py-2 font-medium text-muted-foreground w-8">#</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground w-24">Code</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">Worker Name</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground w-44">Status</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">Notes</th>
            </tr>
          </thead>
          <tbody>
            {visibleWorkers.map((worker) => {
              const idx = workers.findIndex((item) => item.id === worker.id);
              const status = attendanceMap[worker.id] ?? "Present";
              return (
                <tr
                  key={worker.id}
                  data-testid={`row-worker-${worker.id}`}
                  className="attendance-table-row border-b border-border/50 transition-colors last:border-0 hover:bg-muted/20"
                >
                  <td className="px-4 py-2 text-muted-foreground">{idx + 1}</td>
                  <td
                    className="attendance-worker-code px-4 py-2 font-mono text-xs text-muted-foreground"
                    data-testid={`text-worker-code-${worker.id}`}
                  >
                    {worker.employeeCode ?? "—"}
                  </td>
                  <td className="px-4 py-2" dir="auto">
                    <div className="attendance-worker-name font-medium" data-testid={`text-worker-name-${worker.id}`}>
                      {worker.fullName}
                    </div>
                    {(worker.position || worker.department) && (
                      <div className="attendance-worker-position mt-0.5 text-[11px] text-muted-foreground">
                        {worker.position || worker.department}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <Select value={status} onValueChange={(v) => setStatus(worker.id, v as AttendanceStatus)}>
                      <SelectTrigger
                        data-testid={`select-status-${worker.id}`}
                        data-attendance-status={status}
                        className={`attendance-status-trigger h-9 rounded-lg bg-background/70 text-xs font-medium ${STATUS_COLORS[status] ?? ""}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-4 py-2">
                    <Input
                      data-testid={`input-notes-${worker.id}`}
                      placeholder="Optional notes"
                      value={notesMap[worker.id] ?? ""}
                      onChange={(e) => setNotes(worker.id, e.target.value)}
                      className="attendance-notes-input h-9 rounded-lg bg-background/70 text-xs"
                      dir="auto"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-2.5 p-3 sm:hidden">
        {visibleWorkers.map((worker) => {
          const idx = workers.findIndex((item) => item.id === worker.id);
          const status = attendanceMap[worker.id] ?? "Present";
          return (
            <div
              key={worker.id}
              data-testid={`card-worker-${worker.id}`}
              className="attendance-worker-mobile space-y-3 rounded-xl border border-border/70 bg-background/40 p-3.5 shadow-xs"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-sm" dir="auto" data-testid={`text-worker-name-mobile-${worker.id}`}>
                    {worker.fullName}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {worker.employeeCode && (
                      <span className="font-mono" data-testid={`text-worker-code-mobile-${worker.id}`}>
                        {worker.employeeCode}
                      </span>
                    )}
                    {(worker.position || worker.department) && <span>{worker.position || worker.department}</span>}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">{idx + 1}</span>
              </div>
              <Select value={status} onValueChange={(v) => setStatus(worker.id, v as AttendanceStatus)}>
                <SelectTrigger
                  data-testid={`select-status-mobile-${worker.id}`}
                  data-attendance-status={status}
                  className={`attendance-status-trigger h-10 rounded-lg bg-background/70 text-sm font-medium ${STATUS_COLORS[status] ?? ""}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                data-testid={`input-notes-mobile-${worker.id}`}
                placeholder="Notes (optional)"
                value={notesMap[worker.id] ?? ""}
                onChange={(e) => setNotes(worker.id, e.target.value)}
                className="attendance-notes-input h-9 rounded-lg bg-background/70 text-xs"
                dir="auto"
              />
            </div>
          );
        })}
      </div>
    </>
  );
}
