import { useState, useMemo } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EtaFilterValue } from "./gitContainerTypes";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type CheckState = "checked" | "unchecked" | "indeterminate";

function buildTree(dates: string[]): Record<string, Record<string, string[]>> {
  const tree: Record<string, Record<string, string[]>> = {};
  for (const d of dates) {
    const [y, m, day] = d.split("-");
    if (!tree[y]) tree[y] = {};
    if (!tree[y][m]) tree[y][m] = [];
    tree[y][m].push(day);
  }
  return tree;
}

function toRadix(s: CheckState): boolean | "indeterminate" {
  if (s === "checked") return true;
  if (s === "unchecked") return false;
  return "indeterminate";
}

interface EtaDateFilterProps {
  value: EtaFilterValue;
  onChange: (v: EtaFilterValue) => void;
  /** All unique ETA date strings ("YYYY-MM-DD") present in the full container list */
  allEtaDates: string[];
  /** True if any container in the list has a null/empty ETA */
  hasContainersWithNoEta: boolean;
  testId?: string;
}

export function EtaDateFilter({ value, onChange, allEtaDates, hasContainersWithNoEta, testId }: EtaDateFilterProps) {
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(allEtaDates), [allEtaDates]);
  const years = useMemo(() => Object.keys(tree).sort(), [tree]);

  // Normalize selection to a working Set
  const selectedDates = useMemo(
    () => (value === "ALL" ? new Set(allEtaDates) : new Set(value.selectedDates)),
    [value, allEtaDates]
  );
  const includeNoEta = value === "ALL" ? true : value.includeNoEta;

  // Commit a new selection back to the parent
  function commit(next: Set<string>, noEta: boolean) {
    const arr = [...next];
    // Collapse back to "ALL" when everything is selected
    if (noEta && arr.length === allEtaDates.length) {
      onChange("ALL");
    } else {
      onChange({ selectedDates: arr, includeNoEta: noEta });
    }
  }

  // ── State checkers ──────────────────────────────────────────────────────────
  function daySelected(date: string) {
    return selectedDates.has(date);
  }

  function monthState(y: string, m: string): CheckState {
    const days = tree[y]?.[m] ?? [];
    const n = days.filter((d) => selectedDates.has(`${y}-${m}-${d}`)).length;
    if (n === 0) return "unchecked";
    if (n === days.length) return "checked";
    return "indeterminate";
  }

  function yearState(y: string): CheckState {
    const months = Object.keys(tree[y] ?? {});
    const states = months.map((m) => monthState(y, m));
    if (states.every((s) => s === "checked")) return "checked";
    if (states.every((s) => s === "unchecked")) return "unchecked";
    return "indeterminate";
  }

  function overallState(): CheckState {
    const datesAll = allEtaDates.length === 0 || allEtaDates.every((d) => selectedDates.has(d));
    const datesNone = allEtaDates.every((d) => !selectedDates.has(d));
    const noEtaFull = !hasContainersWithNoEta || includeNoEta;
    const noEtaNone = !hasContainersWithNoEta || !includeNoEta;
    if (datesAll && noEtaFull) return "checked";
    if (datesNone && noEtaNone) return "unchecked";
    return "indeterminate";
  }

  // ── Toggles ─────────────────────────────────────────────────────────────────
  function toggleAll() {
    if (overallState() === "checked") {
      onChange({ selectedDates: [], includeNoEta: false });
    } else {
      onChange("ALL");
    }
  }

  function toggleNoEta() {
    commit(selectedDates, !includeNoEta);
  }

  function toggleDay(date: string) {
    const next = new Set(selectedDates);
    if (next.has(date)) next.delete(date);
    else next.add(date);
    commit(next, includeNoEta);
  }

  function toggleMonth(y: string, m: string) {
    const next = new Set(selectedDates);
    const days = (tree[y]?.[m] ?? []).map((d) => `${y}-${m}-${d}`);
    if (monthState(y, m) === "checked") {
      days.forEach((d) => next.delete(d));
    } else {
      days.forEach((d) => next.add(d));
    }
    commit(next, includeNoEta);
  }

  function toggleYear(y: string) {
    const next = new Set(selectedDates);
    const allYearDates = Object.entries(tree[y] ?? {}).flatMap(([m, days]) => days.map((d) => `${y}-${m}-${d}`));
    if (yearState(y) === "checked") {
      allYearDates.forEach((d) => next.delete(d));
    } else {
      allYearDates.forEach((d) => next.add(d));
    }
    commit(next, includeNoEta);
  }

  // ── Expand/collapse helpers ──────────────────────────────────────────────────
  function toggleYearExpand(y: string) {
    const next = new Set(expandedYears);
    if (next.has(y)) next.delete(y);
    else next.add(y);
    setExpandedYears(next);
  }

  function toggleMonthExpand(key: string) {
    const next = new Set(expandedMonths);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpandedMonths(next);
  }

  // ── Trigger label ───────────────────────────────────────────────────────────
  const label = useMemo(() => {
    if (value === "ALL") return "All";
    const { selectedDates: sd, includeNoEta: noEta } = value;
    if (sd.length === 0 && !noEta) return "None";
    if (sd.length === 0 && noEta) return "No ETA";
    if (sd.length === 1 && !noEta) return sd[0];
    const suffix = noEta ? " + No ETA" : "";
    return `${sd.length} date${sd.length !== 1 ? "s" : ""}${suffix}`;
  }, [value]);

  const isActive = value !== "ALL";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 text-xs w-full justify-between font-normal px-2",
            isActive && "border-primary/60 bg-primary/5"
          )}
          data-testid={testId ?? "select-filter-eta"}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 ml-1 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-52 p-1" align="start" sideOffset={4}>
        {/* ── Select All ── */}
        <Row checked={toRadix(overallState())} label="(Select All)" onClick={toggleAll} />

        <div className="border-t my-1" />

        {/* ── No ETA ── */}
        {hasContainersWithNoEta && <Row checked={includeNoEta} label="(No ETA)" onClick={toggleNoEta} />}

        {/* ── Year / Month / Day tree ── */}
        <div className="max-h-64 overflow-y-auto">
          {years.map((year) => {
            const ys = yearState(year);
            const yExpanded = expandedYears.has(year);
            return (
              <div key={year}>
                <Row
                  checked={toRadix(ys)}
                  label={year}
                  onClick={() => toggleYear(year)}
                  expandable
                  expanded={yExpanded}
                  onToggleExpand={() => toggleYearExpand(year)}
                  depth={0}
                />
                {yExpanded &&
                  Object.keys(tree[year])
                    .sort()
                    .map((month) => {
                      const ms = monthState(year, month);
                      const mKey = `${year}-${month}`;
                      const mExpanded = expandedMonths.has(mKey);
                      const monthName = MONTH_NAMES[parseInt(month) - 1];
                      return (
                        <div key={month}>
                          <Row
                            checked={toRadix(ms)}
                            label={monthName}
                            onClick={() => toggleMonth(year, month)}
                            expandable
                            expanded={mExpanded}
                            onToggleExpand={() => toggleMonthExpand(mKey)}
                            depth={1}
                          />
                          {mExpanded &&
                            tree[year][month].map((day) => (
                              <Row
                                key={day}
                                checked={daySelected(`${year}-${month}-${day}`)}
                                label={day}
                                onClick={() => toggleDay(`${year}-${month}-${day}`)}
                                depth={2}
                              />
                            ))}
                        </div>
                      );
                    })}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Internal row component ───────────────────────────────────────────────────
function Row({
  checked,
  label,
  onClick,
  depth = 0,
  expandable = false,
  expanded = false,
  onToggleExpand,
}: {
  checked: boolean | "indeterminate";
  label: string;
  onClick: () => void;
  depth?: number;
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  return (
    <div
      className="flex items-center gap-1.5 py-[5px] rounded-xs cursor-pointer hover:bg-muted/60 select-none text-xs"
      style={{ paddingLeft: `${6 + depth * 14}px`, paddingRight: "6px" }}
      onClick={onClick}
    >
      {/* Expand/collapse chevron */}
      {expandable ? (
        <button
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand?.();
          }}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}

      <Checkbox
        checked={checked}
        className="h-3.5 w-3.5 shrink-0"
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={onClick}
      />
      <span className="truncate leading-none">{label}</span>
    </div>
  );
}
