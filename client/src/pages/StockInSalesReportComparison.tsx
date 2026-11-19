import { ArrowLeftRight, BarChart3, Check, ChevronDown, GitCompare, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PeriodFilter } from "@/components/ui/period-filter";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  useStockInSalesReportComparisonState,
  type GroupingType,
  type LocationOption,
  type StockGroupOption,
} from "./useStockInSalesReportComparisonState";
import { StockInSalesReportComparisonSection } from "./StockInSalesReportComparisonSection";
import { StockInSalesReportComparisonExport } from "./StockInSalesReportComparisonExport";
import { SearchField } from "@/components/ui/search-field";

function GroupMultiSelect({
  groups,
  selectedIds,
  onChange,
  side,
}: {
  groups: StockGroupOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  side: "a" | "b";
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between" data-testid={`button-comparison-groups-${side}`}>
          {selectedIds.length === 0
            ? "All stock groups"
            : `${selectedIds.length} group${selectedIds.length === 1 ? "" : "s"}`}
          <ChevronDown className="h-4 w-4 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="max-h-72 space-y-1 overflow-y-auto">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted"
            onClick={() => onChange([])}
          >
            <Checkbox checked={selectedIds.length === 0} className="pointer-events-none" />
            <span className="font-medium">All stock groups</span>
          </button>
          <div className="border-t" />
          {groups.map((group) => {
            const id = String(group.id);
            const checked = selectedIds.includes(id);
            return (
              <button
                type="button"
                key={group.id}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted"
                onClick={() => onChange(checked ? selectedIds.filter((value) => value !== id) : [...selectedIds, id])}
              >
                <Checkbox checked={checked} className="pointer-events-none" />
                <span>{group.name}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SidePanel({
  title,
  locationId,
  onLocationChange,
  groupIds,
  onGroupsChange,
  locations,
  groups,
  side,
}: {
  title: string;
  locationId: string;
  onLocationChange: (value: string) => void;
  groupIds: string[];
  onGroupsChange: (ids: string[]) => void;
  locations: LocationOption[];
  groups: StockGroupOption[];
  side: "a" | "b";
}) {
  return (
    <div className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
          {side.toUpperCase()}
        </div>
        <div>
          <p className="font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">One location and any number of stock groups</p>
        </div>
      </div>
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Location</label>
        <Select value={locationId} onValueChange={onLocationChange}>
          <SelectTrigger data-testid={`select-comparison-location-${side}`}>
            <SelectValue placeholder="Choose a location" />
          </SelectTrigger>
          <SelectContent>
            {locations.map((location) => (
              <SelectItem key={location.id} value={String(location.id)}>
                {location.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Stock groups</label>
        <GroupMultiSelect groups={groups} selectedIds={groupIds} onChange={onGroupsChange} side={side} />
      </div>
    </div>
  );
}

export default function StockInSalesReportComparison() {
  const {
    clearComparison,
    data,
    error,
    formatMetric,
    formatPeriod,
    grouping,
    isError,
    isFetching,
    isLoading,
    itemMetric,
    itemPage,
    itemTotalPages,
    pagedItemRows,
    period,
    refetch,
    renderValue,
    search,
    selectedCompany,
    selectedItemMetric,
    setGrouping,
    setItemMetric,
    setItemPage,
    setPeriod,
    setSearch,
    setSideAGroupIds,
    setSideALocationId,
    setSideBGroupIds,
    setSideBLocationId,
    sideAGroupIds,
    sideALabel,
    sideALocationId,
    sideBGroupIds,
    sideBLabel,
    sideBLocationId,
    sortedGroups,
    sortedLocations,
    summary,
    swapSides,
  } = useStockInSalesReportComparisonState();

  return (
    <div className="container mx-auto space-y-6 p-0 sm:p-6">
      <PageHeader
        title="Stock & Sales Comparison"
        subtitle="Compare one location and stock-group selection against another"
        onBack={() => window.history.back()}
        meta={<span>Difference is Side A minus Side B{selectedCompany?.name ? ` · ${selectedCompany.name}` : ""}</span>}
      >
        <Button variant="outline" size="sm" onClick={clearComparison}>
          Clear
        </Button>
        <StockInSalesReportComparisonExport
          data={data}
          formatMetric={formatMetric}
          formatPeriod={formatPeriod}
          itemMetric={itemMetric}
          period={period}
          selectedItemMetric={selectedItemMetric}
          sideALabel={sideALabel}
          sideBLabel={sideBLabel}
          summary={summary}
        />
      </PageHeader>

      <div className="grid grid-cols-2 items-center gap-2 rounded-xl border bg-card p-2 sm:flex sm:flex-wrap sm:p-3 *:min-w-0">
        <PeriodFilter value={period} onChange={setPeriod} data-testid="period-filter-stock-in-sales-comparison" />
        <Select value={grouping} onValueChange={(value) => setGrouping(value as GroupingType)}>
          <SelectTrigger className="w-full sm:w-32" data-testid="select-stock-in-sales-comparison-grouping">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
            <SelectItem value="yearly">Yearly</SelectItem>
          </SelectContent>
        </Select>
        <SearchField
          value={search}
          onValueChange={setSearch}
          placeholder="Search item, group, location..."
          wrapperClassName="col-span-2 flex-1 sm:min-w-52 sm:max-w-sm"
        />
        {isFetching && !isLoading && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr] lg:items-center">
        <SidePanel
          title="Side A"
          locationId={sideALocationId}
          onLocationChange={setSideALocationId}
          groupIds={sideAGroupIds}
          onGroupsChange={setSideAGroupIds}
          locations={sortedLocations}
          groups={sortedGroups}
          side="a"
        />
        <Button
          variant="outline"
          size="icon"
          onClick={swapSides}
          disabled={!sideALocationId && !sideBLocationId}
          title="Swap sides"
        >
          <ArrowLeftRight className="h-4 w-4" />
        </Button>
        <SidePanel
          title="Side B"
          locationId={sideBLocationId}
          onLocationChange={setSideBLocationId}
          groupIds={sideBGroupIds}
          onGroupsChange={setSideBGroupIds}
          locations={sortedLocations}
          groups={sortedGroups}
          side="b"
        />
      </div>

      {!sideALocationId || !sideBLocationId ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-14 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <GitCompare className="h-6 w-6 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium">Choose both comparison locations</p>
            <p className="mt-1 text-sm text-muted-foreground">
              You may use the same location on both sides to compare different stock groups.
            </p>
          </div>
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border py-12 text-center">
          <BarChart3 className="h-8 w-8 text-destructive" />
          <div>
            <p className="font-medium">Unable to load the comparison</p>
            <p className="mt-1 text-sm text-muted-foreground">{error?.message || "The comparison request failed."}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" /> Retry
          </Button>
        </div>
      ) : (
        <StockInSalesReportComparisonSection
          data={data}
          formatPeriod={formatPeriod}
          isLoading={isLoading}
          itemMetric={itemMetric}
          itemPage={itemPage}
          itemTotalPages={itemTotalPages}
          pagedItemRows={pagedItemRows}
          renderValue={renderValue}
          selectedItemMetric={selectedItemMetric}
          setItemMetric={setItemMetric}
          setItemPage={setItemPage}
          sideALabel={sideALabel}
          sideBLabel={sideBLabel}
          summary={summary}
        />
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="h-3.5 w-3.5" />
        <span>Direct container offloads only; sales use stored historical cost and credit/debit notes are netted.</span>
      </div>
    </div>
  );
}
