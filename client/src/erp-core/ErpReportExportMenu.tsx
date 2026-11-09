import type { ReactNode } from "react";
import { ChevronDown, Download, FileSpreadsheet, FileText, Printer } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ErpReportExportOption {
  id: string;
  label: string;
  kind?: "excel" | "csv" | "print" | "custom";
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  icon?: ReactNode;
  testId?: string;
}

/**
 * One export menu for ERP report headers. The menu invokes the page-owned
 * export handler, preserving all filters, permission checks and report math.
 */
export interface ErpReportExportMenuProps {
  options: readonly ErpReportExportOption[];
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  size?: ButtonProps["size"];
  className?: string;
  "data-testid"?: string;
}

const icons = {
  excel: FileSpreadsheet,
  csv: FileText,
  print: Printer,
  custom: FileText,
} as const;

export function ErpReportExportMenu({
  options,
  disabled = false,
  busy = false,
  label = "Export",
  size,
  className,
  "data-testid": testId,
}: ErpReportExportMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
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
      <DropdownMenuContent align="end">
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
