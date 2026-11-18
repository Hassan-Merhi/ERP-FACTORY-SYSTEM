/**
 * Shared presentation for the Factory Workers and Employees rosters (owner
 * decision 1: keep both screens, give them the same features and layout).
 * Every piece takes its data and handlers from the page, so each roster keeps
 * its own API, permission checks and payroll figures.
 */
import type { ElementType, ReactNode } from "react";
import { Pencil, Plus, SlidersHorizontal, UserCheck, UserX, Users, X } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchField } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/StatusBadge";
import { ReportExportMenu, type ReportExportOption } from "@/components/export/ReportExportMenu";
import { getAvatarColor, getInitials } from "../factoryworkers/utils";

/** One header style for both roster tables. */
export const PEOPLE_TABLE_HEAD_CLASS = "py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground";

export type PeopleStatusFilter = "All" | "Active" | "Inactive";

export function matchesPeopleStatus(filter: string, active: boolean): boolean {
  return filter === "All" || (filter === "Active" && active) || (filter === "Inactive" && !active);
}

export interface PeopleKpiCard {
  label: string;
  value: string;
  icon: ElementType;
  /** Highlights the card that carries the main amount. */
  emphasis?: boolean;
}

export function PeopleKpiCards({
  cards,
  loading,
  "data-testid": testId,
}: {
  cards: readonly PeopleKpiCard[];
  loading?: boolean;
  "data-testid"?: string;
}) {
  const columns =
    cards.length >= 7 ? "sm:grid-cols-3 xl:grid-cols-7" : cards.length >= 4 ? "lg:grid-cols-4" : "sm:grid-cols-3";
  return (
    <div className={`grid grid-cols-2 gap-3 ${columns}`} data-testid={testId}>
      {loading
        ? cards.map((card) => <Skeleton key={card.label} className="h-[76px] rounded-xl" />)
        : cards.map(({ label, value, icon: Icon, emphasis }) => (
            <div
              key={label}
              className="min-w-0 rounded-xl border border-border/70 bg-card p-3 shadow-sm sm:p-3.5"
              data-testid={`people-kpi-${label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <div className="shrink-0 rounded-lg bg-primary/10 p-2 text-primary">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="block text-xs text-muted-foreground">{label}</span>
                  <span
                    className={`block truncate pt-1 text-lg font-bold tracking-tight tabular-nums ${emphasis ? "text-primary" : "text-foreground"}`}
                    title={value}
                  >
                    {value}
                  </span>
                </div>
              </div>
            </div>
          ))}
    </div>
  );
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

export function PersonNameCell({
  name,
  code,
  photoUrl,
  badge,
  testIdSuffix,
}: {
  name: string;
  code?: string | null;
  photoUrl?: string | null;
  /** Small marker drawn on the avatar (e.g. the worker documents dot). */
  badge?: ReactNode;
  testIdSuffix: string | number;
}) {
  const avatarColor = getAvatarColor(name);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="relative shrink-0">
        <Avatar className={`h-8 w-8 text-xs font-semibold ${avatarColor}`}>
          {photoUrl ? <AvatarImage src={photoUrl} /> : null}
          <AvatarFallback className={avatarColor}>{getInitials(name)}</AvatarFallback>
        </Avatar>
        {badge}
      </div>
      <div className="flex min-w-0 flex-col">
        {code && (
          <span
            className="font-mono text-xs leading-tight text-muted-foreground"
            data-testid={`text-code-${testIdSuffix}`}
          >
            {code}
          </span>
        )}
        <span className="wrap-break-word text-sm font-medium leading-snug" data-testid={`text-name-${testIdSuffix}`}>
          {name}
        </span>
      </div>
    </div>
  );
}

export function PersonStatusBadge({ active, "data-testid": testId }: { active: boolean; "data-testid"?: string }) {
  return <StatusBadge status={active ? "active" : "inactive"} data-testid={testId} />;
}

export function PeopleRowActions({
  active,
  onEdit,
  onEndContract,
  onReactivate,
  reactivating,
  testIdSuffix,
}: {
  active: boolean;
  onEdit: () => void;
  onEndContract: () => void;
  onReactivate: () => void;
  reactivating?: boolean;
  testIdSuffix: { edit: string; end: string; reactivate: string };
}) {
  return (
    <div
      className="flex items-center justify-end gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 touch:opacity-100"
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        size="icon"
        variant="ghost"
        onClick={onEdit}
        title="Edit"
        aria-label="Edit"
        data-testid={testIdSuffix.edit}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      {active ? (
        <Button
          size="icon"
          variant="ghost"
          onClick={onEndContract}
          title="End Contract"
          aria-label="End Contract"
          data-testid={testIdSuffix.end}
        >
          <UserX className="h-3.5 w-3.5 text-destructive" />
        </Button>
      ) : (
        <Button
          size="icon"
          variant="ghost"
          onClick={onReactivate}
          disabled={reactivating}
          title="Reactivate"
          aria-label="Reactivate"
          data-testid={testIdSuffix.reactivate}
        >
          <UserCheck className="h-3.5 w-3.5 text-emerald-600" />
        </Button>
      )}
    </div>
  );
}

export function PeopleEmptyRow({ colSpan, title, hint }: { colSpan: number; title: string; hint: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan}>
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <Users className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium" data-testid="text-empty">
            {title}
          </p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      </TableCell>
    </TableRow>
  );
}

/** "Filter" toggle with the active-filter count, plus "Clear filters" when any is set. */
export function PeopleFilterButton({
  open,
  onToggle,
  activeCount,
  onClear,
}: {
  open: boolean;
  onToggle: () => void;
  activeCount: number;
  onClear: () => void;
}) {
  return (
    <>
      <Button
        variant={open || activeCount > 0 ? "default" : "outline"}
        onClick={onToggle}
        className="relative h-10"
        aria-expanded={open}
        data-testid="button-toggle-filters"
      >
        <SlidersHorizontal className="mr-1.5 h-4 w-4" />
        Filter
        {activeCount > 0 && (
          <span className="ml-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-background text-[11px] font-bold text-foreground">
            {activeCount}
          </span>
        )}
      </Button>
      {activeCount > 0 && (
        <Button variant="ghost" className="h-10 px-2 text-xs" onClick={onClear} data-testid="button-clear-filters">
          Clear filters
        </Button>
      )}
    </>
  );
}

export function PeopleFilterPanel({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-4 rounded-xl border bg-muted/30 p-4" data-testid="people-filter-panel">
      {children}
    </div>
  );
}

export function PeopleFilterSelect({
  label,
  value,
  onChange,
  allLabel,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  allLabel: string;
  options: readonly { value: string; label: string }[];
  testId?: string;
}) {
  return (
    <div className="flex min-w-[150px] flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 bg-background text-sm" aria-label={label} data-testid={testId}>
          <SelectValue placeholder={allLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
