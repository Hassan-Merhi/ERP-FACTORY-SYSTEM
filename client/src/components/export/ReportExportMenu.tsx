import type { ReactNode } from "react";
import { ChevronDown, Download, FileSpreadsheet, FileText, Loader2, Printer } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type ReportExportKind = "excel" | "csv" | "pdf" | "print" | "custom";

export interface ReportExportOption {
  id: string;
  label: string;
  kind?: ReportExportKind;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  icon?: ReactNode;
  testId?: string;
}

/**
 * The one export menu for report and list headers in every company type
 * (ERP, Factory, Properties, Retail, Supplier Partner, POS). The menu only
 * invokes the page-owned handler, so filters, permission checks and report
 * math stay with the page.
 *
 * Standard: trigger label "Export" with the Download icon; items in the order
 * Excel, CSV, PDF, Print. See docs/ui-unification/plan.md.
 */
export interface ReportExportMenuProps {
  options: readonly ReportExportOption[];
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
  align?: "start" | "center" | "end";
  "data-testid"?: string;
}

const icons = {
  excel: FileSpreadsheet,
  csv: FileText,
  pdf: FileText,
  print: Printer,
  custom: FileText,
} as const;

/** Default item labels, so the same action reads the same on every page. */
export const REPORT_EXPORT_LABELS = {
  excel: "Export Excel",
  csv: "Export CSV",
  pdf: "Export PDF",
  print: "Print",
} as const;

export function ReportExportMenu({
  options,
  disabled = false,
  busy = false,
  label = "Export",
  size,
  variant = "outline",
  className,
  align = "end",
  "data-testid": testId,
}: ReportExportMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          className={className}
          disabled={disabled || busy || options.length === 0}
          aria-busy={busy || undefined}
          data-testid={testId}
        >
          <Download className="mr-2 h-4 w-4" aria-hidden="true" />
          {busy ? "Exporting…" : label}
          <ChevronDown className="ml-2 h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {options.map((option) => {
          const Icon = icons[option.kind ?? "custom"];
          return (
            <DropdownMenuItem
              key={option.id}
              disabled={busy || option.disabled}
              onSelect={() => {
                void option.onSelect();
              }}
              data-testid={option.testId ?? `export-option-${option.id}`}
            >
              {option.icon ?? <Icon className="mr-2 h-4 w-4" aria-hidden="true" />}
              {option.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface ExportButtonProps extends Omit<ButtonProps, "children"> {
  /** Which single export this button performs. Sets the default label. */
  kind?: Exclude<ReportExportKind, "custom">;
  /** Overrides the default label for `kind` (for example "Export Cost Excel"). */
  label?: string;
  busy?: boolean;
  /** Hide the text on narrow screens, keeping the accessible name. */
  iconOnlyOnPhone?: boolean;
}

/**
 * A single export or print action. Use this when a page offers exactly one
 * format; use `ReportExportMenu` when it offers more than one.
 */
export function ExportButton({
  kind = "excel",
  label,
  busy = false,
  disabled,
  variant = "outline",
  iconOnlyOnPhone = false,
  type = "button",
  ...props
}: ExportButtonProps) {
  const text = label ?? REPORT_EXPORT_LABELS[kind];
  const Icon = kind === "print" ? Printer : Download;
  return (
    <Button type={type} variant={variant} disabled={disabled || busy} aria-busy={busy || undefined} {...props}>
      {busy ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
      )}
      <span className={iconOnlyOnPhone ? "sr-only sm:not-sr-only" : undefined}>
        {busy ? (kind === "print" ? "Preparing…" : "Exporting…") : text}
      </span>
    </Button>
  );
}
