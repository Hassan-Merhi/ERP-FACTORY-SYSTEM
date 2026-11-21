// Extracted from ./PerWorkerView.tsx
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Save, UserCheck, UserX, ChevronsUpDown, Check } from "lucide-react";
import { attendanceToday } from "../attendanceEditPolicy";
import { usePerWorkerViewState } from "./usePerWorkerViewState";

export function PerWorkerViewCard({
  dates,
  deselectAll,
  endDate,
  handleSave,
  loadingWorkers,
  recordChanges,
  saveMutation,
  selectAll,
  selectedWorker,
  selectedWorkerId,
  setEndDate,
  setSelectedWorkerId,
  setStartDate,
  setWorkerComboOpen,
  startDate,
  workerComboOpen,
  workerIdNum,
  workersList,
}: Pick<
  ReturnType<typeof usePerWorkerViewState>,
  | "dates"
  | "deselectAll"
  | "endDate"
  | "handleSave"
  | "loadingWorkers"
  | "recordChanges"
  | "saveMutation"
  | "selectAll"
  | "selectedWorker"
  | "selectedWorkerId"
  | "setEndDate"
  | "setSelectedWorkerId"
  | "setStartDate"
  | "setWorkerComboOpen"
  | "startDate"
  | "workerComboOpen"
  | "workerIdNum"
  | "workersList"
>) {
  return (
    <Card className="overflow-hidden border-border/70 bg-card/75 shadow-none">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1 min-w-[200px]">
            <Label className="text-xs text-muted-foreground">Worker</Label>
            <Popover open={workerComboOpen} onOpenChange={setWorkerComboOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={workerComboOpen}
                  data-testid="select-worker"
                  className="w-56 justify-between rounded-xl bg-background/70 font-normal"
                >
                  <span className="truncate" dir="auto">
                    {selectedWorker
                      ? `${selectedWorker.fullName}${selectedWorker.employeeCode ? ` (${selectedWorker.employeeCode})` : ""}`
                      : loadingWorkers
                        ? "Loading…"
                        : "Select worker"}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search worker…" data-testid="input-worker-search" />
                  <CommandList>
                    <CommandEmpty>No workers found.</CommandEmpty>
                    <CommandGroup>
                      {(workersList ?? []).map((w) => (
                        <CommandItem
                          key={w.id}
                          value={`${w.fullName} ${w.employeeCode ?? ""}`}
                          onSelect={() => {
                            setSelectedWorkerId(String(w.id));
                            setWorkerComboOpen(false);
                          }}
                        >
                          <Check
                            className={`mr-2 h-4 w-4 shrink-0 ${selectedWorkerId === String(w.id) ? "opacity-100" : "opacity-0"}`}
                          />
                          <span dir="auto" className="truncate">
                            {w.fullName}
                            {w.employeeCode ? ` (${w.employeeCode})` : ""}
                          </span>
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
              data-testid="input-start-date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-40 rounded-xl bg-background/70"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">To</Label>
            <Input
              type="date"
              max={attendanceToday()}
              data-testid="input-end-date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-40 rounded-xl bg-background/70"
            />
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="default"
              data-testid="button-select-all"
              onClick={selectAll}
              disabled={!workerIdNum || dates.length === 0}
            >
              <UserCheck className="h-4 w-4 mr-1" />
              Select All
            </Button>
            <Button
              variant="outline"
              size="default"
              data-testid="button-deselect-all"
              onClick={deselectAll}
              disabled={!workerIdNum || dates.length === 0}
            >
              <UserX className="h-4 w-4 mr-1" />
              Deselect All
            </Button>
            {recordChanges.allowed && (
              <Button
                size="default"
                data-testid="button-save-per-worker"
                onClick={handleSave}
                disabled={
                  !workerIdNum ||
                  dates.length === 0 ||
                  saveMutation.isPending ||
                  dates.some((d) => d > attendanceToday())
                }
              >
                <Save className="h-4 w-4 mr-1" />
                {saveMutation.isPending ? "Saving…" : "Save Attendance"}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
