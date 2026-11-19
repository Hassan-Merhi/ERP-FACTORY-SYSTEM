// Extracted from ./BulkDialogs.tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { encodeLocationOption } from "./payrollUtils";
import { ChevronRight, Loader2, Printer, RefreshCw } from "lucide-react";
import type { BulkDialogsProps } from "./BulkDialogs";
import type { useCurrencyContext } from "@/contexts/CurrencyContext";

export function BulkBonusDialog({
  formatAmount,
  bulkBonusDialogOpen,
  setBulkBonusStep,
  setBulkBonusDialogOpen,
  bulkBonusStep,
  bulkBonusDate,
  setBulkBonusDate,
  bulkBonusNotes,
  setBulkBonusNotes,
  bulkBonusAutoMonth,
  setBulkBonusAutoMonth,
  bulkBonusAutoStart,
  setBulkBonusAutoStart,
  bulkBonusAutoEnd,
  setBulkBonusAutoEnd,
  autoCalculateBonuses,
  bulkBonusAutoLoading,
  bulkBonusAutoPctLocationId,
  setBulkBonusAutoPctLocationId,
  locations,
  allCompanyLocations,
  employeeStaff,
  pendingBonuses,
  bulkBonusBreakdowns,
  bulkBonusAmounts,
  setBulkBonusAmounts,
  handlePrintBulkBonus,
  bulkBonusMutation,
}: {
  formatAmount: ReturnType<typeof useCurrencyContext>["formatAmount"];
  bulkBonusDialogOpen: BulkDialogsProps["bulkBonusDialogOpen"];
  setBulkBonusStep: BulkDialogsProps["setBulkBonusStep"];
  setBulkBonusDialogOpen: BulkDialogsProps["setBulkBonusDialogOpen"];
  bulkBonusStep: BulkDialogsProps["bulkBonusStep"];
  bulkBonusDate: BulkDialogsProps["bulkBonusDate"];
  setBulkBonusDate: BulkDialogsProps["setBulkBonusDate"];
  bulkBonusNotes: BulkDialogsProps["bulkBonusNotes"];
  setBulkBonusNotes: BulkDialogsProps["setBulkBonusNotes"];
  bulkBonusAutoMonth: BulkDialogsProps["bulkBonusAutoMonth"];
  setBulkBonusAutoMonth: BulkDialogsProps["setBulkBonusAutoMonth"];
  bulkBonusAutoStart: BulkDialogsProps["bulkBonusAutoStart"];
  setBulkBonusAutoStart: BulkDialogsProps["setBulkBonusAutoStart"];
  bulkBonusAutoEnd: BulkDialogsProps["bulkBonusAutoEnd"];
  setBulkBonusAutoEnd: BulkDialogsProps["setBulkBonusAutoEnd"];
  autoCalculateBonuses: BulkDialogsProps["autoCalculateBonuses"];
  bulkBonusAutoLoading: BulkDialogsProps["bulkBonusAutoLoading"];
  bulkBonusAutoPctLocationId: BulkDialogsProps["bulkBonusAutoPctLocationId"];
  setBulkBonusAutoPctLocationId: BulkDialogsProps["setBulkBonusAutoPctLocationId"];
  locations: BulkDialogsProps["locations"];
  allCompanyLocations: BulkDialogsProps["allCompanyLocations"];
  employeeStaff: BulkDialogsProps["employeeStaff"];
  pendingBonuses: BulkDialogsProps["pendingBonuses"];
  bulkBonusBreakdowns: BulkDialogsProps["bulkBonusBreakdowns"];
  bulkBonusAmounts: BulkDialogsProps["bulkBonusAmounts"];
  setBulkBonusAmounts: BulkDialogsProps["setBulkBonusAmounts"];
  handlePrintBulkBonus: BulkDialogsProps["handlePrintBulkBonus"];
  bulkBonusMutation: BulkDialogsProps["bulkBonusMutation"];
}) {
  return (
    <Dialog
      open={bulkBonusDialogOpen}
      onOpenChange={(open) => {
        if (!open) {
          setBulkBonusStep("edit");
        }
        setBulkBonusDialogOpen(open);
      }}
    >
      <DialogContent
        className="max-w-4xl w-[95vw] max-h-[85vh] overflow-hidden flex flex-col"
        data-testid="dialog-bulk-bonus"
      >
        <DialogHeader>
          <DialogTitle>Bulk Bonus Deposit</DialogTitle>
          <DialogDescription>
            {bulkBonusStep === "edit"
              ? "Enter bonus amounts for each employee. Leave blank or zero to skip."
              : "Review the bonuses below before confirming."}
          </DialogDescription>
        </DialogHeader>

        {bulkBonusStep === "edit" ? (
          <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Bonus Date</Label>
                <Input
                  type="date"
                  value={bulkBonusDate}
                  onChange={(e) => setBulkBonusDate(e.target.value)}
                  data-testid="input-bulk-bonus-date"
                />
              </div>
              <div className="space-y-2">
                <Label>Notes (optional)</Label>
                <Input
                  placeholder="e.g., Q4 2025 performance bonus"
                  value={bulkBonusNotes}
                  onChange={(e) => setBulkBonusNotes(e.target.value)}
                  data-testid="input-bulk-bonus-notes"
                />
              </div>
            </div>

            <div className="border rounded-md p-3 space-y-2 bg-muted/30">
              <p className="text-sm font-medium">Auto-Calculate from Saved Rates</p>
              <div className="flex flex-wrap gap-2 items-center">
                <Button
                  type="button"
                  size="sm"
                  variant={bulkBonusAutoMonth === "thisMonth" ? "default" : "outline"}
                  onClick={() => setBulkBonusAutoMonth("thisMonth")}
                >
                  This Month
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={bulkBonusAutoMonth === "custom" ? "default" : "outline"}
                  onClick={() => setBulkBonusAutoMonth("custom")}
                >
                  Custom
                </Button>
                {bulkBonusAutoMonth === "custom" && (
                  <>
                    <Input
                      type="date"
                      className="h-8 w-36 text-sm"
                      value={bulkBonusAutoStart}
                      onChange={(e) => setBulkBonusAutoStart(e.target.value)}
                    />
                    <Input
                      type="date"
                      className="h-8 w-36 text-sm"
                      value={bulkBonusAutoEnd}
                      onChange={(e) => setBulkBonusAutoEnd(e.target.value)}
                    />
                  </>
                )}
                <Button
                  type="button"
                  size="sm"
                  onClick={autoCalculateBonuses}
                  disabled={bulkBonusAutoLoading}
                  data-testid="button-auto-calculate-bonuses"
                >
                  {bulkBonusAutoLoading ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-1" />
                  )}
                  Calculate All
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground whitespace-nowrap">Sales % location:</span>
                <Select value={bulkBonusAutoPctLocationId} onValueChange={setBulkBonusAutoPctLocationId}>
                  <SelectTrigger className="h-7 text-xs w-44" data-testid="select-bulk-bonus-pct-location">
                    <SelectValue placeholder="Select for % bonus" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>This Company</SelectLabel>
                      {locations.map((loc) => (
                        // The company is part of the value so the sales total
                        // is read from the company that actually sells at the
                        // location, not from whoever owns the location row.
                        <SelectItem key={loc.id} value={encodeLocationOption(loc.id, loc.companyId)}>
                          {loc.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    {allCompanyLocations.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Other Companies</SelectLabel>
                        {allCompanyLocations.map((loc) => (
                          <SelectItem
                            key={`oc-${loc.companyId}-${loc.id}`}
                            value={encodeLocationOption(loc.id, loc.companyId)}
                          >
                            {loc.name} ({loc.companyName})
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
                {bulkBonusAutoPctLocationId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => setBulkBonusAutoPctLocationId("")}
                  >
                    Clear
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Per-unit bale rates use their configured locations. Sales % bonus uses the location selected above
                (leave blank to skip % calculation).
              </p>
            </div>

            <div className="border rounded-md flex-1 overflow-hidden">
              <div className="max-h-[400px] overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead className="text-right w-40">Bonus Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {employeeStaff.map((emp) => {
                      const isPending = !!pendingBonuses[emp.id];
                      const breakdown = bulkBonusBreakdowns[emp.id];
                      return (
                        <TableRow key={emp.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span>
                                {emp.firstName} {emp.lastName}
                              </span>
                              {isPending && (
                                <Badge variant="secondary" className="text-xs">
                                  Calculated
                                </Badge>
                              )}
                            </div>
                            {breakdown && breakdown.length > 0 && (
                              <div className="mt-1 space-y-0.5">
                                {breakdown.map((line, i) => (
                                  <p key={i} className="text-xs text-muted-foreground font-mono">
                                    {line}
                                  </p>
                                ))}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              step="0.01"
                              min="0"
                              placeholder="0.00"
                              className="text-right font-mono w-32 ml-auto"
                              value={bulkBonusAmounts[emp.id] || ""}
                              onChange={(e) => setBulkBonusAmounts((prev) => ({ ...prev, [emp.id]: e.target.value }))}
                              data-testid={`input-bonus-${emp.id}`}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t">
              <div className="text-sm">
                <span className="text-muted-foreground">Total: </span>
                <span className="font-semibold font-mono">
                  {formatAmount(Object.values(bulkBonusAmounts).reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0))}
                </span>
                <span className="text-muted-foreground ml-2">
                  ({Object.values(bulkBonusAmounts).filter((amt) => parseFloat(amt) > 0).length} employees)
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setBulkBonusDialogOpen(false)}
                  data-testid="button-cancel-bulk-bonus"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => setBulkBonusStep("preview")}
                  disabled={Object.values(bulkBonusAmounts).filter((amt) => parseFloat(amt) > 0).length === 0}
                  data-testid="button-preview-bulk-bonus"
                >
                  Preview <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
            <div className="border rounded-md flex-1 overflow-hidden">
              <div className="max-h-[420px] overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {employeeStaff
                      .filter((emp) => parseFloat(bulkBonusAmounts[emp.id] || "0") > 0)
                      .map((emp) => {
                        const pending = pendingBonuses[emp.id];
                        return (
                          <TableRow key={emp.id}>
                            <TableCell className="font-medium">
                              {emp.firstName} {emp.lastName}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                              {pending?.description || bulkBonusNotes || "Bonus"}
                            </TableCell>
                            <TableCell className="text-right font-mono font-semibold">
                              {formatAmount(parseFloat(bulkBonusAmounts[emp.id] || "0"))}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t">
              <div className="text-sm">
                <span className="text-muted-foreground">Total: </span>
                <span className="font-semibold font-mono">
                  {formatAmount(Object.values(bulkBonusAmounts).reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0))}
                </span>
                <span className="text-muted-foreground ml-2">
                  ({Object.values(bulkBonusAmounts).filter((amt) => parseFloat(amt) > 0).length} employees)
                </span>
                {bulkBonusDate && <span className="text-muted-foreground ml-2">· {bulkBonusDate}</span>}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setBulkBonusStep("edit")} data-testid="button-back-bulk-bonus">
                  Back
                </Button>
                <Button variant="outline" onClick={handlePrintBulkBonus} data-testid="button-print-bulk-bonus">
                  <Printer className="h-4 w-4 mr-2" />
                  Print
                </Button>
                <Button
                  onClick={() => bulkBonusMutation.mutate()}
                  disabled={bulkBonusMutation.isPending}
                  data-testid="button-confirm-bulk-bonus"
                >
                  {bulkBonusMutation.isPending ? "Processing..." : "Confirm & Deposit"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
