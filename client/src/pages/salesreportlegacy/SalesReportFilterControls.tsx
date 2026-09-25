import type { Dispatch, SetStateAction } from "react";
import { Building2, ChevronDown, GitMerge } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ApiListRow } from "@shared/apiTypes";

import type { GroupingType, ProfitFilter } from "./types";

type Setter<T> = Dispatch<SetStateAction<T>>;

export interface SalesReportFilterControlsProps {
  periodFilter: PeriodFilterValue;
  setPeriodFilter: Setter<PeriodFilterValue>;
  isMultiCompanyMode: boolean;
  setIsMultiCompanyMode: Setter<boolean>;
  companyFilterOptions: [string, string][];
  selectedCompanies: string[];
  setSelectedCompanies: Setter<string[]>;
  grouping: GroupingType;
  setGrouping: Setter<GroupingType>;
  profitFilter: ProfitFilter;
  setProfitFilter: Setter<ProfitFilter>;
  mergeView: boolean;
  setMergeView: Setter<boolean>;
  locations: ApiListRow[];
  selectedLocations: string[];
  setSelectedLocations: Setter<string[]>;
  stockGroups: ApiListRow[];
  selectedStockGroups: string[];
  setSelectedStockGroups: Setter<string[]>;
  /** The inline bar separates company scope from the report options. */
  showSeparator?: boolean;
}

/**
 * The Sales report's scope and view controls. Rendered once in the desktop bar
 * and once in the ERP phone filter sheet, so both layouts stay in step. Returns
 * a fragment: the caller's flex row or grid owns the layout.
 */
export function SalesReportFilterControls({
  periodFilter,
  setPeriodFilter,
  isMultiCompanyMode,
  setIsMultiCompanyMode,
  companyFilterOptions,
  selectedCompanies,
  setSelectedCompanies,
  grouping,
  setGrouping,
  profitFilter,
  setProfitFilter,
  mergeView,
  setMergeView,
  locations,
  selectedLocations,
  setSelectedLocations,
  stockGroups,
  selectedStockGroups,
  setSelectedStockGroups,
  showSeparator = false,
}: SalesReportFilterControlsProps) {
  return (
    <>
      {/* Company toggle */}
      <Button
        variant={isMultiCompanyMode ? "default" : "outline"}
        size="sm"
        onClick={() => {
          const next = !isMultiCompanyMode;
          setIsMultiCompanyMode(next);
          setSelectedCompanies([]);
          if (next) {
            setSelectedLocations([]);
            if (periodFilter.preset === "this_month") {
              setPeriodFilter(getDefaultPeriodValue("today"));
            }
          }
        }}
        className="gap-1.5"
        data-testid="button-toggle-multi-company"
      >
        <Building2 className="w-4 h-4" />
        {isMultiCompanyMode ? "All Companies" : "Current Company"}
      </Button>

      {/* Company filter (multi-company only) */}
      {isMultiCompanyMode && companyFilterOptions.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-company-filter">
              <Building2 className="w-4 h-4" />
              {selectedCompanies.length === 0 ? "All Companies" : `${selectedCompanies.length} co.`}
              <ChevronDown className="w-3 h-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-52 p-2" align="start">
            <div className="space-y-1">
              <div
                className="flex items-center gap-2 px-2 py-1.5 rounded hover-elevate cursor-pointer"
                onClick={() => setSelectedCompanies([])}
                data-testid="option-all-companies"
              >
                <Checkbox checked={selectedCompanies.length === 0} className="h-4 w-4 pointer-events-none" />
                <span className="text-sm font-medium">All Companies</span>
              </div>
              <div className="border-t my-1" />
              {companyFilterOptions.map(([code, name]) => (
                <div
                  key={code}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover-elevate cursor-pointer"
                  onClick={() =>
                    setSelectedCompanies((prev) =>
                      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
                    )
                  }
                  data-testid={`option-company-${code}`}
                >
                  <Checkbox checked={selectedCompanies.includes(code)} className="h-4 w-4 pointer-events-none" />
                  <span className="text-sm">{name}</span>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {showSeparator && <div className="h-5 w-px bg-border" />}

      {/* Grouping */}
      <Select value={grouping} onValueChange={(value) => setGrouping(value as GroupingType)}>
        <SelectTrigger className="w-28 h-9" data-testid="select-grouping">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="daily">Daily</SelectItem>
          <SelectItem value="monthly">Monthly</SelectItem>
          <SelectItem value="yearly">Yearly</SelectItem>
        </SelectContent>
      </Select>

      {/* Profit filter */}
      <Select value={profitFilter} onValueChange={(value) => setProfitFilter(value as ProfitFilter)}>
        <SelectTrigger className="w-36 h-9" data-testid="select-profit-filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Profits</SelectItem>
          <SelectItem value="positive">Positive Only</SelectItem>
          <SelectItem value="negative">Negative Only</SelectItem>
        </SelectContent>
      </Select>

      {/* Merge view toggle */}
      <Button
        variant={mergeView ? "default" : "outline"}
        size="sm"
        onClick={() => setMergeView((v) => !v)}
        className="gap-1.5"
        data-testid="button-merge-view"
      >
        <GitMerge className="w-4 h-4" />
        Merged
      </Button>

      {/* Locations multi-select */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            data-testid="button-location-filter"
            disabled={isMultiCompanyMode}
          >
            {selectedLocations.length === 0
              ? "All Locations"
              : `${selectedLocations.length} Location${selectedLocations.length !== 1 ? "s" : ""}`}
            <ChevronDown className="w-3 h-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-2" align="start">
          <div className="space-y-1">
            <div
              className="flex items-center gap-2 px-2 py-1.5 rounded hover-elevate cursor-pointer"
              onClick={() => setSelectedLocations([])}
            >
              <Checkbox checked={selectedLocations.length === 0} className="h-4 w-4" />
              <span className="text-sm font-medium">All Locations</span>
            </div>
            <div className="border-t my-1" />
            {locations.map((loc) => (
              <div
                key={loc.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover-elevate cursor-pointer"
                onClick={() =>
                  setSelectedLocations((prev) =>
                    prev.includes(String(loc.id)) ? prev.filter((l) => l !== String(loc.id)) : [...prev, String(loc.id)]
                  )
                }
                data-testid={`option-location-${loc.id}`}
              >
                <Checkbox checked={selectedLocations.includes(String(loc.id))} className="h-4 w-4" />
                <span className="text-sm">{loc.name}</span>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Groups multi-select */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-group-filter">
            {selectedStockGroups.length === 0
              ? "All Groups"
              : `${selectedStockGroups.length} Group${selectedStockGroups.length !== 1 ? "s" : ""}`}
            <ChevronDown className="w-3 h-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-2" align="start">
          <div className="space-y-1">
            <div
              className="flex items-center gap-2 px-2 py-1.5 rounded hover-elevate cursor-pointer"
              onClick={() => setSelectedStockGroups([])}
            >
              <Checkbox checked={selectedStockGroups.length === 0} className="h-4 w-4" />
              <span className="text-sm font-medium">All Groups</span>
            </div>
            <div className="border-t my-1" />
            {stockGroups.map((g) => (
              <div
                key={g.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover-elevate cursor-pointer"
                onClick={() =>
                  setSelectedStockGroups((prev) =>
                    prev.includes(String(g.id)) ? prev.filter((x) => x !== String(g.id)) : [...prev, String(g.id)]
                  )
                }
                data-testid={`option-group-${g.id}`}
              >
                <Checkbox checked={selectedStockGroups.includes(String(g.id))} className="h-4 w-4" />
                <span className="text-sm">{g.name}</span>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
