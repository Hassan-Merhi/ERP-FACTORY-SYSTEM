// Extracted from ./FactoryProductionTargets.tsx to keep that module under the source-size cap.
import { Fragment } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FACTORY_TRACKING_STATUSES } from "@/i18n/factoryStaffTrackingTranslations";
import { differenceClass, differenceText, statusTranslationKey } from "./factoryProductionTargetsModel";
import { ChevronDown, LockKeyhole } from "lucide-react";
import { useFactoryProductionTargetsState } from "./useFactoryProductionTargetsState";

export function FactoryProductionTargetsSection({
  collapsedGroups,
  groupedVisibleRows,
  isLoading,
  periodType,
  setCollapsedGroups,
  tr,
}: Pick<
  ReturnType<typeof useFactoryProductionTargetsState>,
  "collapsedGroups" | "groupedVisibleRows" | "isLoading" | "periodType" | "setCollapsedGroups" | "tr"
>) {
  return (
    <div className="pt-staff-table">
      <Table mobileLayout="cards">
        <TableHeader>
          <TableRow className="border-b border-border/80 bg-muted/60 hover:bg-muted/60">
            <TableHead className="min-w-[240px] border-r border-border/70 text-sm font-semibold">
              {tr("person")}
            </TableHead>
            <TableHead className="w-[170px] min-w-[170px] max-w-[170px] border-r border-border/70 text-sm font-semibold">
              {tr("category")}
            </TableHead>
            <TableHead className="w-[125px] border-r border-border/70 text-right text-sm font-semibold">
              {tr("target")}
            </TableHead>
            <TableHead className="w-[120px] border-r border-border/70 text-right text-sm font-semibold">
              {tr("produced")}
            </TableHead>
            <TableHead className="w-[120px] border-r border-border/70 text-right text-sm font-semibold">
              {tr("difference")}
            </TableHead>
            <TableHead className="w-[155px] text-sm font-semibold">{tr("status")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={6} className="py-12 text-center text-base text-muted-foreground">
                {tr("loadingStaff")}
              </TableCell>
            </TableRow>
          ) : groupedVisibleRows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-12 text-center text-base text-muted-foreground">
                {tr("noMatchingStaff")}
              </TableCell>
            </TableRow>
          ) : (
            groupedVisibleRows.map((group, groupIndex) => (
              <Fragment key={group.label.toLocaleLowerCase() || "__blank-group__"}>
                <TableRow className={`pt-category-row pt-category-row--${groupIndex % 4}`}>
                  <TableCell colSpan={6} className="py-2">
                    <button
                      type="button"
                      className="pt-category-toggle"
                      aria-expanded={!collapsedGroups.has(group.label)}
                      aria-label={`${collapsedGroups.has(group.label) ? "Expand" : "Collapse"} ${group.label || "Uncategorized"}`}
                      onClick={() =>
                        setCollapsedGroups((previous) => {
                          const next = new Set(previous);
                          if (next.has(group.label)) next.delete(group.label);
                          else next.add(group.label);
                          return next;
                        })
                      }
                    >
                      <span className="flex items-center gap-2.5">
                        <ChevronDown
                          className={`h-4 w-4 transition-transform ${collapsedGroups.has(group.label) ? "-rotate-90" : ""}`}
                        />
                        <span className="text-sm font-bold">{group.label || "—"}</span>
                      </span>
                      <span className="pt-category-count">{group.rows.length}</span>
                    </button>
                  </TableCell>
                </TableRow>
                {!collapsedGroups.has(group.label) &&
                  group.rows.map((row) => {
                    const members = row.displayMembers ?? [
                      {
                        personId: row.personId,
                        name: row.name,
                        code: row.code,
                        status: row.status,
                        active: row.active,
                      },
                    ];
                    const isAbsent =
                      periodType !== "daily"
                        ? (row.absentDays ?? 0) > 0
                        : members.some((member) => member.status === FACTORY_TRACKING_STATUSES.absent);
                    const comparisonTarget =
                      periodType === "daily"
                        ? row.targetBales
                        : (row.missingTargetDays ?? 0) > 0 || row.targetBales == null
                          ? null
                          : row.targetBales - (row.absentTargetBales ?? 0);
                    return (
                      <TableRow
                        key={row.linkGroupId != null ? `link-${row.linkGroupId}` : `worker-${row.personId}`}
                        className={`pt-worker-row border-b ${
                          isAbsent ? "bg-red-500/5 hover:bg-red-500/10" : ""
                        } ${!row.active ? "opacity-60" : ""}`}
                      >
                        <TableCell className="border-r border-border/70 py-3">
                          <div className="space-y-1" dir="auto">
                            {members.map((member) => (
                              <div
                                key={member.personId}
                                className={`text-base font-semibold leading-6 ${!member.active ? "opacity-60" : ""}`}
                              >
                                {member.name}
                              </div>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="w-[170px] min-w-[170px] max-w-[170px] border-r border-border/70">
                          <span className="pt-category-pill">{row.category || "—"}</span>
                        </TableCell>
                        <TableCell className="border-r border-border/70 text-right text-base font-semibold tabular-nums">
                          {row.targetBales ?? "—"}
                        </TableCell>
                        <TableCell className="border-r border-border/70 text-right text-base font-semibold tabular-nums">
                          {row.producedBales ?? 0}
                        </TableCell>
                        <TableCell
                          className={`border-r border-border/70 text-right text-base font-semibold tabular-nums ${differenceClass(comparisonTarget, row.producedBales)}`}
                        >
                          {differenceText(comparisonTarget, row.producedBales)}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1.5">
                            {members.map((member) => {
                              const memberAbsent =
                                periodType !== "daily"
                                  ? (row.absentDays ?? 0) > 0
                                  : member.status === FACTORY_TRACKING_STATUSES.absent;
                              return (
                                <div
                                  key={member.personId}
                                  className={`pt-status-pill ${memberAbsent ? "pt-status-pill--absent" : ""}`}
                                  aria-disabled="true"
                                  title={
                                    periodType === "daily"
                                      ? `${member.name}: ${tr("statusControlledFromAttendance")}`
                                      : `${member.name}: ${row.absentDays ?? 0} absent out of ${row.periodDays ?? 0} roster days`
                                  }
                                >
                                  <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
                                  <span>
                                    {periodType === "daily"
                                      ? tr(statusTranslationKey(member.status))
                                      : (row.absentDays ?? 0) > 0
                                        ? `${tr("absent")} ${row.absentDays}/${row.periodDays ?? 0}`
                                        : tr("present")}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </Fragment>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
