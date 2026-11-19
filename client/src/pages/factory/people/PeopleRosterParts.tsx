// Extracted from ./PeopleRoster.tsx
import type { ElementType, ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchField } from "@/components/ui/search-field";
import { ReportExportMenu, type ReportExportOption } from "@/components/export/ReportExportMenu";

/** One header style for both roster tables. */
export const PEOPLE_TABLE_HEAD_CLASS = "py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground";

export type PeopleStatusFilter = "All" | "Active" | "Inactive";

export interface PeopleKpiCard {
  label: string;
  value: string;
  icon: ElementType;
  /** Highlights the card that carries the main amount. */
  emphasis?: boolean;
}

export interface PeopleRosterToolbarProps {
  searchPlaceholder: string;
  search: string;
  onSearchChange: (value: string) => void;
  status: string;
  onStatusChange: (value: string) => void;
  /** Extra controls placed after the status filter (filter button, Actions menu). */
  children?: ReactNode;
  exportOptions: readonly ReportExportOption[];
  exportBusy?: boolean;
  /** "Add Worker" / "Add Employee". Hidden when `onAdd` is undefined. */
  addLabel: string;
  onAdd?: () => void;
  searchTestId: string;
  statusTestId: string;
  addTestId: string;
}

export function PeopleRosterToolbar({
  searchPlaceholder,
  search,
  onSearchChange,
  status,
  onStatusChange,
  children,
  exportOptions,
  exportBusy,
  addLabel,
  onAdd,
  searchTestId,
  statusTestId,
  addTestId,
}: PeopleRosterToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SearchField
        placeholder={searchPlaceholder}
        value={search}
        onValueChange={onSearchChange}
        wrapperClassName="flex-1 min-w-[200px]"
        className="h-10"
        data-testid={searchTestId}
      />
      <Select value={status} onValueChange={onStatusChange}>
        <SelectTrigger className="h-10 w-32" data-testid={statusTestId} aria-label="Status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="All">All</SelectItem>
          <SelectItem value="Active">Active</SelectItem>
          <SelectItem value="Inactive">Inactive</SelectItem>
        </SelectContent>
      </Select>
      {children}
      <ReportExportMenu options={exportOptions} busy={exportBusy} className="h-10" data-testid="button-people-export" />
      {onAdd && (
        <Button onClick={onAdd} className="h-10" data-testid={addTestId}>
          <Plus className="mr-2 h-4 w-4" />
          {addLabel}
        </Button>
      )}
    </div>
  );
}

export interface PeopleFilterChip {
  key: string;
  /** Filter name ("Position"), or the whole chip text when there is no value. */
  label: string;
  value?: string;
  onRemove: () => void;
}

export function PeopleFilterChips({ chips, resultCount }: { chips: readonly PeopleFilterChip[]; resultCount: number }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="people-filter-chips">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
        >
          {chip.value === undefined ? (
            chip.label
          ) : (
            <>
              {chip.label}: {chip.value}
            </>
          )}
          <button
            type="button"
            onClick={chip.onRemove}
            className="hover:opacity-70"
            aria-label="Remove filter"
            title="Remove filter"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <span className="self-center text-xs text-muted-foreground">
        {resultCount} {resultCount === 1 ? "result" : "results"}
      </span>
    </div>
  );
}
