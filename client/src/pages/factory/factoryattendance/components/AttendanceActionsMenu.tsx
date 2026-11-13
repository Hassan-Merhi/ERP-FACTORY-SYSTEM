import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, FileDown, Printer, RotateCcw, UserCheck, UserX } from "lucide-react";
import type { AttendanceStatus } from "../types";

export type AttendancePrintKind = "blank" | "results" | "excel-blank" | "excel-results";

/** The attendance page's Actions menu (bulk marking, reset, printing and exports). */
export function AttendanceActionsMenu({
  disabled,
  canChange = true,
  onMarkAll,
  onReset,
  onPrint,
}: {
  disabled: boolean;
  /** False for roles that may not change existing attendance: hides marking and reset. */
  canChange?: boolean;
  onMarkAll: (status: AttendanceStatus) => void;
  onReset: () => void;
  onPrint: (kind: AttendancePrintKind) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="default"
          data-testid="button-actions-dropdown"
          disabled={disabled}
          className="rounded-xl"
        >
          Actions
          <ChevronDown className="ml-1 h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {canChange && (
          <>
            <DropdownMenuItem data-testid="menu-mark-all-present" onClick={() => onMarkAll("Present")}>
              <UserCheck className="mr-2 h-4 w-4" />
              Mark All Present
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="menu-mark-all-absent" onClick={() => onMarkAll("Absent")}>
              <UserX className="mr-2 h-4 w-4" />
              Mark All Absent
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="menu-reset" onClick={onReset}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem data-testid="menu-print-blank" onClick={() => onPrint("blank")}>
          <Printer className="mr-2 h-4 w-4" />
          Print Blank Sheet
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="menu-export-excel-blank" onClick={() => onPrint("excel-blank")}>
          <FileDown className="mr-2 h-4 w-4" />
          Blank Excel
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="menu-export-pdf" onClick={() => onPrint("results")}>
          <Printer className="mr-2 h-4 w-4" />
          Print Results
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="menu-export-excel" onClick={() => onPrint("excel-results")}>
          <FileDown className="mr-2 h-4 w-4" />
          Export Excel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
