import { ChevronDown, Columns, Filter, RotateCcw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ALL_COLUMNS, STATUS_OPTIONS } from "./utils";
import type { useSupplierProfitCheckModel } from "./useSupplierProfitCheckModel";

type ProfitModel = ReturnType<typeof useSupplierProfitCheckModel>;

export function SupplierProfitCheckFilters({ model }: { model: ProfitModel }) {
  if (!model.loaded) return null;
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <div className="relative max-sm:w-full">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          placeholder="Search code / name"
          value={model.search}
          onChange={(event) => model.setSearch(event.target.value)}
          className="pl-8 w-48 rounded-lg max-sm:w-full"
          data-testid="input-search"
        />
      </div>

      <Popover open={model.showStatusPicker} onOpenChange={model.setShowStatusPicker}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={`rounded-lg gap-1.5 ${model.activeStatuses.length > 0 ? "border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400" : ""}`}
            data-testid="button-status-filter"
          >
            <Filter className="w-3.5 h-3.5" />
            {model.statusFilterLabel}
            {model.activeStatuses.length > 0 && (
              <Badge className="bg-amber-500 text-white ml-1 px-1.5 py-0 h-4 text-[10px]">
                {model.activeStatuses.length}
              </Badge>
            )}
            <ChevronDown className="w-3.5 h-3.5 ml-auto opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-2" align="start">
          <div className="flex items-center justify-between mb-2 pb-1.5 border-b">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Filter by Status
            </span>
            {model.activeStatuses.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 text-xs px-1.5"
                onClick={() => model.setActiveStatuses([])}
                data-testid="button-clear-status"
              >
                Clear
              </Button>
            )}
          </div>
          <div className="space-y-0.5">
            {STATUS_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex items-center gap-2.5 px-1.5 py-1.5 rounded-md hover-elevate cursor-pointer"
                data-testid={`status-filter-${option.value}`}
              >
                <Checkbox
                  checked={model.activeStatuses.includes(option.value)}
                  onCheckedChange={() => model.toggleStatus(option.value)}
                />
                <span className={`w-2 h-2 rounded-full shrink-0 ${option.dot}`} />
                <span className="text-sm">{option.label}</span>
              </label>
            ))}
          </div>
          <div className="mt-2 pt-1.5 border-t">
            <p className="text-[10px] text-muted-foreground px-1.5">Select multiple to combine filters</p>
          </div>
        </PopoverContent>
      </Popover>

      <Popover open={model.showColPicker} onOpenChange={model.setShowColPicker}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="rounded-lg gap-1.5" data-testid="button-columns">
            <Columns className="w-3.5 h-3.5" /> Columns
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2" align="start">
          <div className="flex items-center justify-between mb-2 pb-1.5 border-b">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Columns</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 text-xs px-1.5"
              onClick={model.resetCols}
              data-testid="button-reset-columns"
            >
              <RotateCcw className="w-3 h-3 mr-1" /> Reset
            </Button>
          </div>
          <div className="space-y-0.5">
            {ALL_COLUMNS.map((column) => (
              <label
                key={column.key}
                className="flex items-center gap-2.5 px-1.5 py-1.5 rounded-md hover-elevate cursor-pointer"
                data-testid={`col-toggle-${column.key}`}
              >
                <Checkbox
                  checked={model.colVisibility[column.key]}
                  onCheckedChange={() => model.toggleCol(column.key)}
                />
                <span className="text-sm">{column.label}</span>
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {(model.search || model.activeStatuses.length > 0) && (
        <span className="text-xs text-muted-foreground">
          Showing {model.filteredRows.length} of {model.computedRows.length}
        </span>
      )}
    </div>
  );
}
