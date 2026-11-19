// Extracted from ./BalesHistory.tsx to keep that module under the source-size cap.
import { addDays, format } from "date-fns";
import { ChevronDown, ChevronLeft, ChevronRight, FileSpreadsheet, Upload, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LabelPrintSettings } from "@/components/LabelPrintSettings";
import { exportFileName } from "@/lib/exportFile";
import { useBalesHistoryState } from "./useBalesHistoryState";
import { SearchField } from "@/components/ui/search-field";

export function BalesHistorySection({
  bulkUpdateNamesMutation,
  canChangeExistingRecords,
  dateFilter,
  downloadExport,
  importingNames,
  namesFileRef,
  reimportFileRef,
  reimportMutation,
  reimporting,
  searchTerm,
  setDateFilter,
  setImportingNames,
  setReimporting,
  setSearchTerm,
  setStatusFilter,
  statusFilter,
}: Pick<
  ReturnType<typeof useBalesHistoryState>,
  | "bulkUpdateNamesMutation"
  | "canChangeExistingRecords"
  | "dateFilter"
  | "downloadExport"
  | "importingNames"
  | "namesFileRef"
  | "reimportFileRef"
  | "reimportMutation"
  | "reimporting"
  | "searchTerm"
  | "setDateFilter"
  | "setImportingNames"
  | "setReimporting"
  | "setSearchTerm"
  | "setStatusFilter"
  | "statusFilter"
>) {
  return (
    <div className="bales-modern-toolbar">
      <SearchField
        value={searchTerm}
        onValueChange={setSearchTerm}
        placeholder="Search by ref #, code, product, batch..."
        wrapperClassName="bales-modern-search flex-1 min-w-[180px]"
        className="text-sm"
        data-testid="input-bales-search"
      />
      <div className="flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          onClick={() =>
            setDateFilter((prev) => (prev ? format(addDays(new Date(prev + "T00:00:00"), -1), "yyyy-MM-dd") : prev))
          }
          disabled={!dateFilter}
          data-testid="button-prev-date"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Input
          type="date"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
          className="bales-modern-date-input w-[140px] h-8 text-sm"
          data-testid="input-date-filter"
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={() =>
            setDateFilter((prev) => (prev ? format(addDays(new Date(prev + "T00:00:00"), 1), "yyyy-MM-dd") : prev))
          }
          disabled={!dateFilter}
          data-testid="button-next-date"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        {dateFilter && (
          <Button variant="ghost" size="sm" onClick={() => setDateFilter("")} data-testid="button-clear-date">
            Clear
          </Button>
        )}
      </div>
      <Select value={statusFilter} onValueChange={setStatusFilter}>
        <SelectTrigger className="w-[150px] h-8 text-sm" data-testid="select-status-filter">
          <SelectValue placeholder="All Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Status</SelectItem>
          <SelectItem value="PENDING_PRESSING">Pending Pressing</SelectItem>
          <SelectItem value="LABEL_PRINTED">Label Printed</SelectItem>
          <SelectItem value="PRESSED">Pressed</SelectItem>
          <SelectItem value="FINALIZED">Finalized</SelectItem>
          <SelectItem value="IN_STOCK">In Stock</SelectItem>
          <SelectItem value="RESERVED">Reserved</SelectItem>
          <SelectItem value="SOLD">Sold</SelectItem>
          <SelectItem value="REPACKED">Repacked</SelectItem>
        </SelectContent>
      </Select>
      <LabelPrintSettings />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" data-testid="button-tools-menu">
            Tools
            <ChevronDown className="h-3.5 w-3.5 ml-1.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Export / Import</DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() => {
              const exportDate = dateFilter || new Date().toLocaleDateString("en-CA");
              void downloadExport(
                `/api/factory/bales/export-full.xlsx?date=${exportDate}`,
                exportFileName("bales", "xlsx", { date: exportDate })
              );
            }}
            data-testid="button-export-bales-full"
          >
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Export Excel (Bales, {dateFilter || "Today"})
          </DropdownMenuItem>
          {canChangeExistingRecords && (
            <DropdownMenuItem
              onClick={() => reimportFileRef.current?.click()}
              disabled={reimportMutation.isPending || reimporting}
              data-testid="button-reimport-bales"
            >
              <Upload className="h-4 w-4 mr-2" />
              {reimportMutation.isPending ? "Reimporting..." : "Reimport Bales"}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() =>
              void downloadExport("/api/factory/bales/export-names.xlsx", exportFileName("bale names", "xlsx"))
            }
            data-testid="button-export-bale-names"
          >
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Export Excel (Names)
          </DropdownMenuItem>
          {canChangeExistingRecords && (
            <DropdownMenuItem
              onClick={() => namesFileRef.current?.click()}
              disabled={bulkUpdateNamesMutation.isPending || importingNames}
              data-testid="button-import-bale-names"
            >
              <Upload className="h-4 w-4 mr-2" />
              {bulkUpdateNamesMutation.isPending ? "Importing..." : "Import Names"}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={reimportFileRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            setReimporting(true);
            reimportMutation.mutate(file);
            e.target.value = "";
          }
        }}
        data-testid="input-reimport-bales"
      />
      <input
        ref={namesFileRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            setImportingNames(true);
            bulkUpdateNamesMutation.mutate(file);
            e.target.value = "";
          }
        }}
        data-testid="input-import-bale-names"
      />
    </div>
  );
}

export function BalesHistorySection2({
  authError,
  removalReason,
  setAuthError,
  setRemovalReason,
  setSupervisorPassword,
  setSupervisorUsername,
  supervisorPassword,
  supervisorUsername,
}: Pick<
  ReturnType<typeof useBalesHistoryState>,
  | "authError"
  | "removalReason"
  | "setAuthError"
  | "setRemovalReason"
  | "setSupervisorPassword"
  | "setSupervisorUsername"
  | "supervisorPassword"
  | "supervisorUsername"
>) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm text-muted-foreground mb-1">Supervisor Username</p>
        <Input
          value={supervisorUsername}
          onChange={(e) => {
            setSupervisorUsername(e.target.value);
            setAuthError("");
          }}
          placeholder="Enter supervisor username..."
          data-testid="input-supervisor-username"
        />
      </div>
      <div>
        <p className="text-sm text-muted-foreground mb-1">Supervisor Password</p>
        <Input
          type="password"
          value={supervisorPassword}
          onChange={(e) => {
            setSupervisorPassword(e.target.value);
            setAuthError("");
          }}
          placeholder="Enter supervisor password..."
          data-testid="input-supervisor-password"
        />
      </div>
      <div>
        <p className="text-sm text-muted-foreground mb-1">Reason for Removal</p>
        <Input
          value={removalReason}
          onChange={(e) => setRemovalReason(e.target.value)}
          placeholder="Entered by mistake, damaged, etc..."
          data-testid="input-removal-reason"
        />
      </div>
      {authError && (
        <div className="flex items-center gap-2 text-destructive text-sm">
          <XCircle className="h-4 w-4" />
          {authError}
        </div>
      )}
    </div>
  );
}
