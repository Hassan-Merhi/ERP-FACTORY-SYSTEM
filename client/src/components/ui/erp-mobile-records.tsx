import * as React from "react";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResponsiveDataList, ResponsiveDataListEmpty } from "@/components/ui/responsive-data-list";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { cn } from "@/lib/utils";
import type {
  ErpMobileRecordField,
  ErpMobileRecordCardProps,
  ErpMobileRecordListProps,
  ErpMobileSummaryItem,
  ErpMobileAction,
} from "./erp-mobile-records-types";
export type {
  ErpMobileRecordField,
  ErpMobileRecordCardProps,
  ErpMobileRecordListProps,
  ErpMobileSummaryItem,
  ErpMobileAction,
} from "./erp-mobile-records-types";

/**
 * Bespoke ERP phone record presentation, for screens whose rows do not map onto a table
 * (`<Table mobileLayout="cards">` covers the rest): statements, activity feeds, grouped
 * operational lists. Every component here is presentation only; pages pass the values they
 * already compute, so business logic stays shared with the desktop table.
 */

function FieldGrid({ fields, className }: { fields: ErpMobileRecordField[]; className?: string }) {
  return (
    <dl className={cn("grid min-w-0 grid-cols-2 gap-x-3 gap-y-2", className)}>
      {fields.map((field, index) => (
        <div key={index} className={cn("min-w-0", field.wide && "col-span-2", field.className)}>
          <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {field.label}
          </dt>
          <dd
            className={cn("mt-0.5 min-w-0 wrap-break-word text-sm text-foreground", field.numeric && "tabular-nums")}
            dir={field.numeric ? "ltr" : undefined}
            style={field.numeric ? { unicodeBidi: "isolate", textAlign: "start" } : undefined}
          >
            {field.value ?? "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One phone record: title, headline value, label/value fields, optional details and actions. */
export function ErpMobileRecordCard({
  title,
  subtitle,
  badges,
  value,
  valueClassName,
  fields = [],
  details = [],
  children,
  actions,
  onOpen,
  openLabel,
  selected = false,
  className,
  "data-testid": testId,
}: ErpMobileRecordCardProps) {
  const { t } = useApplicationLanguage();
  const [expanded, setExpanded] = React.useState(false);
  const detailsId = React.useId();

  const heading = (
    <div className="flex min-w-0 items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="wrap-break-word text-sm font-semibold leading-snug">{title}</div>
        {(subtitle || badges) && (
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {subtitle && <span className="min-w-0 wrap-break-word">{subtitle}</span>}
            {badges}
          </div>
        )}
      </div>
      {value !== undefined && (
        <div
          className={cn("shrink-0 text-end text-sm font-semibold tabular-nums", valueClassName)}
          dir="ltr"
          style={{ unicodeBidi: "isolate" }}
        >
          {value}
        </div>
      )}
      {onOpen && (
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
      )}
    </div>
  );

  return (
    <li
      className={cn(
        "min-w-0 rounded-lg border bg-card text-card-foreground shadow-2xs",
        selected && "border-primary ring-1 ring-primary",
        className
      )}
      data-testid={testId}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={openLabel}
          className="block w-full min-w-0 rounded-lg p-3 text-start touch-manipulation hover:bg-muted/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {heading}
          {fields.length > 0 && <FieldGrid fields={fields} className="mt-2" />}
        </button>
      ) : (
        <div className="p-3">
          {heading}
          {fields.length > 0 && <FieldGrid fields={fields} className="mt-2" />}
        </div>
      )}
      {children && <div className="min-w-0 px-3 pb-3">{children}</div>}
      {details.length > 0 && (
        <div className="border-t px-3">
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            aria-controls={detailsId}
            className="flex min-h-11 w-full items-center justify-between gap-2 text-xs font-medium text-muted-foreground"
          >
            {expanded ? t("mobileRecords.hideDetails") : t("mobileRecords.showDetails")}
            <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
          </button>
          <div id={detailsId} hidden={!expanded}>
            {expanded && <FieldGrid fields={details} className="pb-3" />}
          </div>
        </div>
      )}
      {actions && (
        <div role="group" className="flex flex-wrap items-center justify-end gap-2 border-t px-3 py-2 *:min-h-10">
          {actions}
        </div>
      )}
    </li>
  );
}

/** Stack of {@link ErpMobileRecordCard}s with the shared empty state. */
export function ErpMobileRecordList({
  empty,
  isEmpty = false,
  className,
  children,
  ...props
}: ErpMobileRecordListProps) {
  if (isEmpty) return <ResponsiveDataListEmpty>{empty}</ResponsiveDataListEmpty>;
  return (
    <ResponsiveDataList className={cn("gap-2", className)} {...props}>
      {children}
    </ResponsiveDataList>
  );
}

/** Group heading inside a record list (date, company, location). */
export function ErpMobileRecordGroup({
  label,
  meta,
  children,
  className,
  "data-testid": testId,
}: {
  label: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <section className={cn("min-w-0 space-y-2", className)} data-testid={testId}>
      <div className="flex min-w-0 items-baseline justify-between gap-2 px-1 pt-1">
        <h3 className="min-w-0 wrap-break-word text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </h3>
        {meta && <div className="shrink-0 text-xs tabular-nums text-muted-foreground">{meta}</div>}
      </div>
      {children}
    </section>
  );
}

/** Two-column phone KPI grid (statement totals, stock summaries). */
export function ErpMobileSummaryGrid({
  items,
  className,
  "data-testid": testId,
}: {
  items: ErpMobileSummaryItem[];
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <dl className={cn("grid min-w-0 grid-cols-2 gap-2", className)} data-testid={testId}>
      {items.map((item, index) => (
        <div key={index} className={cn("min-w-0 rounded-lg border bg-card px-3 py-2", item.wide && "col-span-2")}>
          <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {item.label}
          </dt>
          <dd
            className={cn("mt-0.5 truncate text-base font-semibold tabular-nums", item.valueClassName)}
            dir="ltr"
            style={{ unicodeBidi: "isolate", textAlign: "start" }}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Compact "Actions" overflow for phone headers and toolbars: export, print, share and other
 * secondary actions collapse into one menu instead of a row of wide buttons.
 */
export function ErpMobileActionsMenu({
  actions,
  label,
  className,
  iconOnly = false,
  "data-testid": testId = "erp-mobile-actions",
}: {
  actions: Array<ErpMobileAction | false | null | undefined>;
  label?: string;
  className?: string;
  iconOnly?: boolean;
  "data-testid"?: string;
}) {
  const { t } = useApplicationLanguage();
  const visible = actions.filter((action): action is ErpMobileAction => Boolean(action));
  if (visible.length === 0) return null;
  const text = label ?? t("mobileRecords.actions");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={iconOnly ? "icon" : "default"}
          aria-label={text}
          className={cn("min-h-10 gap-2", className)}
          data-testid={testId}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          {!iconOnly && <span>{text}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {visible.map((action, index) => {
          const Icon = action.icon;
          return (
            <React.Fragment key={`${action.label}-${index}`}>
              {action.separated && index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                disabled={action.disabled}
                onSelect={action.onSelect}
                className={cn("min-h-11 gap-2", action.destructive && "text-destructive focus:text-destructive")}
                data-testid={action.testId}
              >
                {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
                {action.label}
              </DropdownMenuItem>
            </React.Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
