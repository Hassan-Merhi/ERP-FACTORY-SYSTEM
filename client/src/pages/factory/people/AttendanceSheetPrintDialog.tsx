/**
 * Language choice + weekly attendance sheet print / Excel for the Employees
 * Attendance tab, using the same sheet builders as the Workers Attendance tab.
 */
import { useToast } from "@/hooks/use-toast";
import { printDocument } from "@/lib/printDocument";
import type { AttendancePrintKind } from "../factoryattendance/components/AttendanceActionsMenu";
import { LanguageChoiceDialog } from "../factoryattendance/components/LanguageChoiceDialog";
import type { AttendanceStatus, PrintLang, WorkerRow } from "../factoryattendance/types";
import {
  exportWeeklyExcel,
  generateWeeklyBlankSheetHtml,
  generateWeeklyResultsSheetHtml,
  getWeekDays,
} from "../factoryattendance/utils";

export interface AttendanceSheetPerson {
  id: number;
  fullName: string;
  code: string | null;
  department: string | null;
}

export function AttendanceSheetPrintDialog({
  kind,
  onClose,
  people,
  attendanceMap,
  notesMap,
  selectedDate,
}: {
  kind: AttendancePrintKind | null;
  onClose: () => void;
  /** Employees shown on the Attendance tab (all active). */
  people: readonly AttendanceSheetPerson[];
  attendanceMap: Record<number, AttendanceStatus>;
  notesMap: Record<number, string>;
  selectedDate: string;
}) {
  const { toast } = useToast();
  const rows: WorkerRow[] = people.map((person) => ({
    id: person.id,
    fullName: person.fullName,
    employeeCode: person.code,
    department: person.department,
    position: null,
    shiftType: null,
    active: true,
  }));

  const choose = (lang: PrintLang) => {
    const weekDays = getWeekDays(selectedDate);
    onClose();
    if (kind === "blank" || kind === "results") {
      const html =
        kind === "blank"
          ? generateWeeklyBlankSheetHtml(rows, weekDays, "", lang, "employee")
          : generateWeeklyResultsSheetHtml(rows, attendanceMap, notesMap, weekDays, selectedDate, "", lang, "employee");
      printDocument(html, {
        onBlocked: () =>
          toast({ title: "Print failed", description: "Allow pop-ups to print.", variant: "destructive" }),
      });
    } else if (kind === "excel-blank" || kind === "excel-results") {
      const results = kind === "excel-results";
      void exportWeeklyExcel(
        rows,
        weekDays,
        "",
        lang,
        results ? "results" : "blank",
        results ? attendanceMap : {},
        results ? notesMap : {},
        selectedDate,
        "employee"
      ).catch((error: unknown) =>
        toast({
          title: "Export failed",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        })
      );
    }
  };

  return (
    <LanguageChoiceDialog
      open={kind !== null}
      onClose={onClose}
      testId="dialog-print-language"
      buttonTestIdPrefix="button-print"
      isExport={Boolean(kind?.startsWith("excel"))}
      onChoose={choose}
    />
  );
}
