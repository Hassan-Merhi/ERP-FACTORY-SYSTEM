// Extracted from ./AdvancesPanel.tsx to keep that module under the source-size cap.
import {
  BookOpen,
  CalendarDays,
  ChevronDown,
  Plus,
  RotateCcw,
  SearchCheck,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAdvancesPanelState } from "./useAdvancesPanelState";

export function AdvancesPanelSection2({
  canChangeExistingRecords,
  filterStatus,
  filterWorker,
  setAddOpen,
  setBulkOpen,
  setCashAdjOpen,
  setFilterStatus,
  setFilterWorker,
  setPostAccountingOpen,
  setReconcileOpen,
  setRepayAuditOpen,
  setRepayByMonthOpen,
  workers,
}: Pick<
  ReturnType<typeof useAdvancesPanelState>,
  | "canChangeExistingRecords"
  | "filterStatus"
  | "filterWorker"
  | "setAddOpen"
  | "setBulkOpen"
  | "setCashAdjOpen"
  | "setFilterStatus"
  | "setFilterWorker"
  | "setPostAccountingOpen"
  | "setReconcileOpen"
  | "setRepayAuditOpen"
  | "setRepayByMonthOpen"
  | "workers"
>) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={filterWorker} onValueChange={setFilterWorker}>
        <SelectTrigger className="w-48" data-testid="select-filter-worker">
          <SelectValue placeholder="All Workers" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Workers</SelectItem>
          {(workers || []).map((w) => (
            <SelectItem key={w.id} value={String(w.id)}>
              {w.fullName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filterStatus} onValueChange={setFilterStatus}>
        <SelectTrigger className="w-40" data-testid="select-filter-status">
          <SelectValue placeholder="All Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Status</SelectItem>
          <SelectItem value="outstanding">Outstanding</SelectItem>
          <SelectItem value="paid">Fully Paid</SelectItem>
        </SelectContent>
      </Select>
      <div className="ml-auto flex items-center gap-2 flex-wrap">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" data-testid="button-advances-actions">
              Actions <ChevronDown className="h-4 w-4 ml-2" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {canChangeExistingRecords && (
              <DropdownMenuItem onClick={() => setRepayByMonthOpen(true)} data-testid="button-repay-by-month">
                <CalendarDays className="h-4 w-4" />
                Repay by Month
              </DropdownMenuItem>
            )}
            {canChangeExistingRecords && (
              <DropdownMenuItem onClick={() => setPostAccountingOpen(true)} data-testid="button-post-accounting">
                <BookOpen className="h-4 w-4" />
                Post Accounting
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => setRepayAuditOpen(true)} data-testid="button-repayment-audit">
              <SearchCheck className="h-4 w-4" />
              Repayment Audit
            </DropdownMenuItem>
            {canChangeExistingRecords && (
              <DropdownMenuItem onClick={() => setCashAdjOpen(true)} data-testid="button-cash-adjustment">
                <SlidersHorizontal className="h-4 w-4" />
                Cash Adjustment
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => setReconcileOpen(true)} data-testid="button-reconcile-advances">
              <RotateCcw className="h-4 w-4" />
              Reconcile Balances
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {canChangeExistingRecords && (
          <>
            <Button variant="outline" onClick={() => setBulkOpen(true)} data-testid="button-bulk-advance">
              <Users className="h-4 w-4 mr-2" />
              Bulk Advance
            </Button>
            <Button onClick={() => setAddOpen(true)} data-testid="button-add-advance">
              <Plus className="h-4 w-4 mr-2" />
              Add Advance
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
