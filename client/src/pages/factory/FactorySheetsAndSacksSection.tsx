// Extracted from ./FactorySheetsAndSacks.tsx to keep that module under the source-size cap.
import { ExportButton } from "@/components/export/ReportExportMenu";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, Columns3, RefreshCw, Search } from "lucide-react";
import { TYPES } from "./factorysheetsandsacks/utils";
import { OPTIONAL_COLUMNS, useFactorySheetsAndSacksState } from "./useFactorySheetsAndSacksState";

export function FactorySheetsAndSacksSection({
  columnVisible,
  exportStock,
  filtered,
  items,
  search,
  selectedVisibleCount,
  setHiddenColumns,
  setSearch,
  setTypeFilter,
  typeFilter,
}: Pick<
  ReturnType<typeof useFactorySheetsAndSacksState>,
  | "columnVisible"
  | "exportStock"
  | "filtered"
  | "items"
  | "search"
  | "selectedVisibleCount"
  | "setHiddenColumns"
  | "setSearch"
  | "setTypeFilter"
  | "typeFilter"
>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 bg-slate-50/80 px-4 py-3 dark:border-slate-700/60 dark:bg-slate-900/40">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, size..."
            aria-label="Search stock"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-56 rounded-xl border-slate-200 bg-background pl-9 dark:border-slate-600 sm:w-64"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger
            aria-label="Filter item type"
            className="h-9 w-36 rounded-xl border-slate-200 bg-background dark:border-slate-600"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(search || typeFilter !== "all") && (
          <span className="text-xs text-muted-foreground">
            Showing {filtered.length} of {items.length}
          </span>
        )}
        {selectedVisibleCount > 0 && (
          <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
            {selectedVisibleCount} selected
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 rounded-xl"
              aria-label="Choose visible stock columns"
            >
              <Columns3 className="h-4 w-4" /> Columns
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 space-y-2 p-3">
            <p className="text-xs font-semibold text-muted-foreground">Visible columns (saved)</p>
            <div className="flex items-center gap-2 rounded-md p-1.5 text-sm">
              <Check className="h-4 w-4 text-emerald-500" /> Name{" "}
              <span className="ml-auto text-[10px] text-muted-foreground">Always shown</span>
            </div>
            {OPTIONAL_COLUMNS.map((column) => (
              <label
                key={column.key}
                className="flex cursor-pointer items-center gap-2 rounded-md p-1.5 text-sm hover:bg-muted"
              >
                <Checkbox
                  checked={columnVisible(column.key)}
                  onCheckedChange={(checked) =>
                    setHiddenColumns((previous) =>
                      checked ? previous.filter((key) => key !== column.key) : [...new Set([...previous, column.key])]
                    )
                  }
                />
                {column.label}
              </label>
            ))}
            <Button size="sm" variant="ghost" className="w-full" onClick={() => setHiddenColumns([])}>
              Show all columns
            </Button>
          </PopoverContent>
        </Popover>
        <ExportButton
          kind="csv"
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 rounded-xl"
          onClick={exportStock}
          disabled={!filtered.length}
          title={selectedVisibleCount ? "Export selected rows" : "Export filtered rows"}
        />
        <ExportButton
          kind="print"
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 rounded-xl print:hidden"
          onClick={() => window.print()}
        />
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 rounded-xl"
          title="Refresh stock"
          aria-label="Refresh stock"
          onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/factory/sheets-sacks"] })}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
