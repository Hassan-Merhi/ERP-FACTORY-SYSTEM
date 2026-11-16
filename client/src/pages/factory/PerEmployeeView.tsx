// Extracted from ./FactoryEmployeeAttendanceTab.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { AttendanceAdminApprovalDialog } from "./factoryattendance/components/AttendanceAdminApprovalDialog";
import { attendancePastDates, attendanceToday } from "./factoryattendance/attendanceEditPolicy";
import { Check, CheckCircle, ChevronsUpDown, Save, User, UserCheck, UserX, XCircle } from "lucide-react";
import { usePerEmployeeViewState } from "./usePerEmployeeViewState";

export function PerEmployeeView() {
  const {
    absentCount,
    approvalDates,
    approvalOpen,
    approveAttendanceSave,
    checkedDates,
    dates,
    empComboOpen,
    empIdNum,
    empList,
    endDate,
    handleSave,
    presentCount,
    recordChanges,
    saveMutation,
    selectedEmp,
    selectedEmpId,
    setApprovalOpen,
    setCheckedDates,
    setEmpComboOpen,
    setEndDate,
    setSelectedEmpId,
    setStartDate,
    startDate,
    weeks,
  } = usePerEmployeeViewState();

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1 min-w-[200px]">
              <Label className="text-xs text-muted-foreground">Employee</Label>
              <Popover open={empComboOpen} onOpenChange={setEmpComboOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={empComboOpen}
                    className="w-56 justify-between font-normal"
                    data-testid="select-employee"
                  >
                    <span className="truncate">
                      {selectedEmp ? `${selectedEmp.firstName} ${selectedEmp.lastName}` : "Select employee"}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search employee…" />
                    <CommandList>
                      <CommandEmpty>No employees found.</CommandEmpty>
                      <CommandGroup>
                        {(empList ?? []).map((e) => (
                          <CommandItem
                            key={e.id}
                            value={`${e.firstName} ${e.lastName} ${e.code ?? ""}`}
                            onSelect={() => {
                              setSelectedEmpId(String(e.id));
                              setEmpComboOpen(false);
                            }}
                          >
                            <Check
                              className={`mr-2 h-4 w-4 shrink-0 ${selectedEmpId === String(e.id) ? "opacity-100" : "opacity-0"}`}
                            />
                            {e.firstName} {e.lastName}
                            {e.code && <span className="ml-1 text-muted-foreground">({e.code})</span>}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input
                type="date"
                max={attendanceToday()}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-40"
                data-testid="input-start-date"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input
                type="date"
                max={attendanceToday()}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-40"
                data-testid="input-end-date"
              />
            </div>
            <div className="flex gap-2 ml-auto items-center flex-wrap">
              <Button
                variant="outline"
                onClick={() => {
                  const n: Record<string, boolean> = {};
                  for (const d of dates) n[d] = true;
                  setCheckedDates(n);
                }}
                disabled={!empIdNum}
                data-testid="button-select-all"
              >
                <UserCheck className="h-4 w-4 mr-1" /> Select All
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const n: Record<string, boolean> = {};
                  for (const d of dates) n[d] = false;
                  setCheckedDates(n);
                }}
                disabled={!empIdNum}
                data-testid="button-deselect-all"
              >
                <UserX className="h-4 w-4 mr-1" /> Deselect All
              </Button>
              {recordChanges.allowed && (
                <Button
                  onClick={handleSave}
                  disabled={!empIdNum || saveMutation.isPending || dates.some((d) => d > attendanceToday())}
                  data-testid="button-save-per-employee"
                >
                  <Save className="h-4 w-4 mr-1" />
                  {saveMutation.isPending ? "Saving…" : "Save"}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {empIdNum && (
        <>
          <div className="flex gap-4 text-sm">
            <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
              <CheckCircle className="h-4 w-4" /> Present: <strong>{presentCount}</strong>
            </span>
            <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
              <XCircle className="h-4 w-4" /> Absent: <strong>{absentCount}</strong>
            </span>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {selectedEmp ? `${selectedEmp.firstName} ${selectedEmp.lastName}` : "Employee"} — {startDate} to{" "}
                {endDate}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {weeks.map((week, wi) => (
                  <div key={wi} className="grid grid-cols-7 gap-1">
                    {week.map((d) => {
                      const isPresent = checkedDates[d];
                      const dayNum = new Date(d + "T00:00:00").getDate();
                      const dayName = new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" });
                      return (
                        <button
                          key={d}
                          onClick={() => setCheckedDates((p) => ({ ...p, [d]: !p[d] }))}
                          data-testid={`day-${d}`}
                          className={`flex flex-col items-center justify-center rounded-md py-2 px-1 text-xs border transition-colors
                            ${
                              isPresent
                                ? "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700 text-green-800 dark:text-green-200"
                                : "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-600 dark:text-red-400"
                            }`}
                        >
                          <span className="font-medium">{dayNum}</span>
                          <span className="text-[11px] opacity-70">{dayName}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {!empIdNum && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <User className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>Select an employee to view and edit attendance.</p>
          </CardContent>
        </Card>
      )}
      {attendancePastDates(dates).length > 0 && (
        <Badge variant="secondary">Earlier dates require Admin approval to save</Badge>
      )}
      <AttendanceAdminApprovalDialog
        open={approvalOpen}
        onOpenChange={setApprovalOpen}
        onApprove={approveAttendanceSave}
        isPending={saveMutation.isPending}
        dates={approvalDates}
      />
    </div>
  );
}
