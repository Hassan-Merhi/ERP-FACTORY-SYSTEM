/**
 * The shared Daybook frame: the ERP Daybook's header, KPI strip, tab strip,
 * results bar, table shell and loading / error / empty states, rendered by the
 * ERP (and Properties), Factory and POS Daybooks alike.
 *
 * Presentation only. Each Daybook keeps its own data source, columns, row
 * renderer, permissions and exports; the frame receives values and handlers.
 */
import type { ReactNode } from "react";
import { BookOpen, ClipboardList, EyeOff, History, type LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ReportExportMenu, type ReportExportOption } from "@/components/export/ReportExportMenu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/page-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuditLog } from "@/pages/settings/AuditLog";
import { cn } from "@/lib/utils";
import type { DaybookTab } from "./useDaybookTab";
import "./daybook-frame.css";

export function DaybookPage({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("daybook-premium flex min-w-0 flex-col gap-4 md:gap-5", className)} {...props}>
      {children}
    </div>
  );
}

export interface DaybookHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  showBackButton?: boolean;
  /** Export menu items; the menu is left out when there are none. */
  exportOptions?: readonly ReportExportOption[];
  exportBusy?: boolean;
  exportDisabled?: boolean;
  /** Further header actions (for example New Voucher), after the export menu. */
  children?: ReactNode;
}

export function DaybookHeader({
  title,
  subtitle,
  meta,
  showBackButton = true,
  exportOptions,
  exportBusy = false,
  exportDisabled = false,
  children,
}: DaybookHeaderProps) {
  return (
    <section className="daybook-hero" aria-label="Daybook heading">
      <PageHeader
        title={title}
        subtitle={subtitle}
        meta={meta}
        icon={<BookOpen className="h-6 w-6" />}
        showBackButton={showBackButton}
      >
        {exportOptions && exportOptions.length > 0 && (
          <ReportExportMenu
            className="daybook-export gap-2"
            busy={exportBusy}
            disabled={exportDisabled}
            options={exportOptions}
            data-testid="button-daybook-export"
          />
        )}
        {children}
      </PageHeader>
    </section>
  );
}

export interface DaybookKpi {
  id: string;
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  icon: LucideIcon;
  /** Accent colour of the card. */
  tone: "count" | "value" | "active" | "optional";
  testId?: string;
}

export function DaybookKpiStrip({
  items,
  label = "Daybook overview",
  "data-testid": testId = "daybook-overview",
}: {
  items: readonly DaybookKpi[];
  label?: string;
  "data-testid"?: string;
}) {
  return (
    <section
      className={cn("daybook-overview", items.length === 3 && "daybook-overview--restricted")}
      aria-label={label}
      data-testid={testId}
    >
      {items.map(({ id, label: kpiLabel, value, caption, icon: Icon, tone, testId: valueTestId }) => (
        <div key={id} className={`daybook-kpi daybook-kpi--${tone}`}>
          <span className="daybook-kpi__icon">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="daybook-kpi__label">{kpiLabel}</div>
            <div className="daybook-kpi__value" data-testid={valueTestId}>
              {value}
            </div>
            {caption ? <div className="daybook-kpi__caption">{caption}</div> : null}
          </div>
        </div>
      ))}
    </section>
  );
}

const TAB_META: Record<DaybookTab, { label: string; icon: LucideIcon }> = {
  transactions: { label: "Transactions", icon: ClipboardList },
  activity: { label: "Edits & Activity", icon: History },
};

/**
 * Transactions / Edits & Activity. The open tab lives in `?tab=` (see
 * useDaybookTab); `children` holds the Transactions panel, the activity panel
 * is the shared audit log.
 */
export function DaybookTabs({
  value,
  onValueChange,
  tabs,
  label = "Daybook sections",
  children,
}: {
  value: DaybookTab;
  onValueChange: (value: DaybookTab) => void;
  tabs: readonly DaybookTab[];
  label?: string;
  children: ReactNode;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onValueChange(next as DaybookTab)}>
      <div className="erp-mobile-scroll-tabs pb-1">
        <TabsList className="daybook-tab-list" aria-label={label}>
          {tabs.map((tab) => {
            const { label: tabLabel, icon: Icon } = TAB_META[tab];
            return (
              <TabsTrigger key={tab} value={tab} data-testid={`tab-daybook-${tab}`}>
                <Icon className="h-4 w-4" aria-hidden="true" />
                {tabLabel}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
      {tabs.includes("transactions") && (
        <TabsContent value="transactions" className="mt-0 space-y-4">
          {children}
        </TabsContent>
      )}
      {tabs.includes("activity") && (
        <TabsContent value="activity" className="daybook-activity-panel mt-2">
          {value === "activity" && <AuditLog context="daybook" defaultActions="all" />}
        </TabsContent>
      )}
    </Tabs>
  );
}

/** "Transactions" title row, its right-hand tools, and the bordered table shell. */
export function DaybookResults({
  title = "Transactions",
  description,
  count,
  tools,
  footer,
  children,
}: {
  title?: string;
  description?: ReactNode;
  count?: ReactNode;
  tools?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="daybook-results-title flex items-center gap-2">
            {title}
            {count !== undefined && count !== null && (
              <span className="text-sm font-normal text-muted-foreground tabular-nums" data-testid="daybook-count">
                ({count})
              </span>
            )}
          </h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {tools ? <div className="flex flex-wrap items-center gap-2">{tools}</div> : null}
      </div>
      <div className="daybook-table-shell">{children}</div>
      {footer}
    </section>
  );
}

export function DaybookShowHiddenButton({
  showHidden,
  onToggle,
  hiddenCount,
}: {
  showHidden: boolean;
  onToggle: () => void;
  hiddenCount: number;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      disabled={hiddenCount === 0}
      className={cn("gap-1.5", showHidden && "text-foreground")}
      data-testid="button-show-hidden"
    >
      <EyeOff className="w-4 h-4" />
      {showHidden ? "Showing hidden" : "Show hidden"}
    </Button>
  );
}

/**
 * Loading, failure and empty are three different situations; a failed request
 * must never look like a day with no transactions. Returns null when there are
 * rows to show.
 */
export function DaybookTableState({
  isLoading,
  errorMessage,
  onRetry,
  isEmpty,
  emptyTitle = "No transactions found for the selected period and filters.",
  emptyDescription,
  emptyAction,
}: {
  isLoading: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
  isEmpty: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
}): React.JSX.Element | null {
  if (errorMessage) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center" role="alert" data-testid="daybook-error">
        <p className="text-sm text-destructive">{errorMessage}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} data-testid="button-daybook-retry">
            Try again
          </Button>
        )}
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="space-y-2 p-4" role="status" aria-label="Loading transactions" data-testid="daybook-loading">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (isEmpty) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
        className="rounded-none border-0"
        data-testid="daybook-empty"
      />
    );
  }
  return null;
}
