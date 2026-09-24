import { useState, useEffect, Fragment, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { hasAnyOpenDialog } from "@/hooks/use-escape-back";
import { useLocationSummaryBandwidth } from "@/hooks/use-location-summary-bandwidth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronDown, ChevronRight, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { PeriodFilter, PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";

interface LocationData {
  quantity: number;
  rate: number;
  value: number;
}

interface StockItemData {
  id: number;
  code: string;
  name: string;
  uom: string;
  locationData: Record<number, LocationData>;
}

interface StockGroupData {
  id: number;
  code: string;
  name: string;
  locationData: Record<number, LocationData>;
  items: StockItemData[];
}

interface _LocationSummaryResponse {
  stockGroups: StockGroupData[];
  grandTotals: Record<number, LocationData>;
  asOfDate: string;
}

interface Location {
  id: number;
  name: string;
  code: string;
}

const STORAGE_KEY = "locationSummary_selectedLocations";
const STATE_KEY = "locationSummary_pageState";

export default function LocationSummary() {
  const mobileCards = useMobileCardTable();
  const [_location, navigate] = useLocation();

  // Load saved state from sessionStorage
  const getSavedState = () => {
    try {
      const saved = sessionStorage.getItem(STATE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  };

  const savedState = getSavedState();

  const [selectedLocationIds, setSelectedLocationIds] = useState<number[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  });
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(() => new Set(savedState?.expandedGroups || []));
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(
    () => savedState?.periodFilter || getDefaultPeriodValue("today")
  );
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(savedState?.selectedRowKey || null);
  const [highlightedRows, setHighlightedRows] = useState<Set<string>>(() => new Set(savedState?.highlightedRows || []));
  const [selectedLocationIndex, setSelectedLocationIndex] = useState<number>(savedState?.selectedLocationIndex || 0);
  const [hiddenRows, setHiddenRows] = useState<Set<string>>(() => new Set(savedState?.hiddenRows || []));
  const tableScrollContainer = useRef<HTMLDivElement>(null);
  // Track interaction mode: 'keyboard' blocks hover selection until pointer moves
  const interactionMode = useRef<"keyboard" | "pointer">("pointer");
  const { toast } = useToast();
  const { formatAmount } = useCurrencyContext();

  // Helper to handle mouse enter - only select if in pointer mode
  const handleMouseEnterRow = (rowKey: string) => {
    if (interactionMode.current === "pointer") {
      setSelectedRowKey(rowKey);
    }
  };

  // Switch back to pointer mode when mouse actually moves
  const handlePointerMove = () => {
    interactionMode.current = "pointer";
  };

  // Save state to sessionStorage whenever it changes
  useEffect(() => {
    const state = {
      expandedGroups: Array.from(expandedGroups),
      periodFilter,
      selectedRowKey,
      highlightedRows: Array.from(highlightedRows),
      selectedLocationIndex,
      hiddenRows: Array.from(hiddenRows),
      scrollTop: tableScrollContainer.current?.scrollTop || 0,
      scrollLeft: tableScrollContainer.current?.scrollLeft || 0,
    };
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  }, [expandedGroups, periodFilter, selectedRowKey, highlightedRows, selectedLocationIndex, hiddenRows]);

  // Restore scroll position on mount
  useEffect(() => {
    if (savedState && tableScrollContainer.current) {
      setTimeout(() => {
        if (tableScrollContainer.current) {
          tableScrollContainer.current.scrollTop = savedState.scrollTop || 0;
          tableScrollContainer.current.scrollLeft = savedState.scrollLeft || 0;
        }
      }, 100);
    }
  }, [savedState]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedLocationIds));
  }, [selectedLocationIds]);

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: summaryData, isLoading } = useLocationSummaryBandwidth({
    selectedLocationIds,
    expandedGroups,
  });

  // Keep locations in the order they were selected
  const selectedLocations = selectedLocationIds
    .map((id) => locations.find((loc) => loc.id === id))
    .filter((loc): loc is Location => loc !== undefined);

  const toggleGroup = (groupId: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const toggleLocation = (locationId: number) => {
    setSelectedLocationIds((prev) =>
      prev.includes(locationId) ? prev.filter((id) => id !== locationId) : [...prev, locationId]
    );
  };

  const formatNumber = (num: number | null | undefined, decimals: number = 2, suffix: string = "") => {
    if (num == null || isNaN(num) || num === 0) return "";
    const formatted = num.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return suffix ? `${formatted} ${suffix}` : formatted;
  };

  const colsPerLocation = 3;
  const totalCols = 1 + selectedLocations.length * colsPerLocation;

  const buildRowKey = (groupId: number | string, itemId?: number | string) =>
    itemId ? `${groupId}-item-${itemId}` : `group-${groupId}`;

  const getAllRows = useCallback(() => {
    if (!summaryData?.stockGroups?.length) return [];
    const rows: Array<{ key: string; groupId: number; itemId?: number; groupIndex: number; itemIndex?: number }> = [];

    summaryData.stockGroups.forEach((group, groupIndex) => {
      const groupKey = buildRowKey(group.id);
      // Skip hidden rows from navigation
      if (!hiddenRows.has(groupKey)) {
        rows.push({ key: groupKey, groupId: group.id, groupIndex });
      }
      if (expandedGroups.has(group.id)) {
        // Sort items alphabetically to match the visual table order
        const sortedItems = [...group.items].sort((a, b) => a.name.localeCompare(b.name));
        sortedItems.forEach((item, itemIndex) => {
          const itemKey = buildRowKey(group.id, item.id);
          // Skip hidden rows from navigation
          if (!hiddenRows.has(itemKey)) {
            rows.push({ key: itemKey, groupId: group.id, itemId: item.id, groupIndex, itemIndex });
          }
        });
      }
    });

    return rows;
  }, [expandedGroups, hiddenRows, summaryData?.stockGroups]);

  // Immediate scroll function - called directly from keydown handler for faster response
  const scrollToRowImmediate = (rowKey: string) => {
    if (!tableScrollContainer.current) return;
    const container = tableScrollContainer.current;
    const rowElement = container.querySelector(`[data-row-key="${rowKey}"]`) as HTMLElement | null;
    if (!rowElement) return;

    const thead = container.querySelector("thead") as HTMLElement | null;
    const headerHeight = thead ? thead.offsetHeight : 60;
    const scrollMargin = 8;
    const rowTop = rowElement.offsetTop;
    const rowBottom = rowTop + rowElement.offsetHeight;
    const viewportTop = container.scrollTop + headerHeight + scrollMargin;
    const viewportBottom = container.scrollTop + container.clientHeight - scrollMargin;

    if (rowTop < viewportTop) {
      container.scrollTop = rowTop - headerHeight - scrollMargin;
    } else if (rowBottom > viewportBottom) {
      container.scrollTop = rowBottom - container.clientHeight + scrollMargin;
    }
  };

  const handleTableKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (locationDialogOpen || !summaryData?.stockGroups?.length) return;

      const allRows = getAllRows();
      if (allRows.length === 0) return;

      const currentIndex = selectedRowKey ? allRows.findIndex((r) => r.key === selectedRowKey) : -1;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (currentIndex > 0) {
          interactionMode.current = "keyboard";
          const newKey = allRows[currentIndex - 1].key;
          scrollToRowImmediate(newKey);
          setSelectedRowKey(newKey);
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        interactionMode.current = "keyboard";
        if (currentIndex === -1) {
          const newKey = allRows[0].key;
          scrollToRowImmediate(newKey);
          setSelectedRowKey(newKey);
        } else if (currentIndex < allRows.length - 1) {
          const newKey = allRows[currentIndex + 1].key;
          scrollToRowImmediate(newKey);
          setSelectedRowKey(newKey);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSelectedLocationIndex((prev) => Math.max(0, prev - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setSelectedLocationIndex((prev) => Math.min(selectedLocations.length - 1, prev + 1));
      } else if (e.key === " ") {
        e.preventDefault();
        if (selectedRowKey) {
          setHighlightedRows((prev) => {
            const next = new Set(prev);
            if (next.has(selectedRowKey)) {
              next.delete(selectedRowKey);
            } else {
              next.add(selectedRowKey);
            }
            return next;
          });
        }
      } else if ((e.altKey || e.metaKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (selectedRowKey) {
          setHiddenRows((prev) => {
            const next = new Set(prev);
            if (next.has(selectedRowKey)) {
              next.delete(selectedRowKey);
              toast({ title: "Row unhidden" });
            } else {
              next.add(selectedRowKey);
              toast({ title: "Row hidden (Alt+R)" });
            }
            return next;
          });
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        // Navigate to LocationMonthlySummary if item row is selected
        if (selectedRowKey && summaryData) {
          const row = allRows.find((r) => r.key === selectedRowKey);
          if (row && row.itemId && selectedLocationIndex >= 0 && selectedLocationIndex < selectedLocations.length) {
            const locationId = selectedLocations[selectedLocationIndex].id;
            navigate(`/locations/${locationId}/stock-items/${row.itemId}/history`);
          }
        }
      } else if (e.key === "Escape") {
        if (hasAnyOpenDialog()) return;
        e.preventDefault();
        window.history.back();
      }
    },
    [
      getAllRows,
      locationDialogOpen,
      navigate,
      selectedLocationIndex,
      selectedLocations,
      selectedRowKey,
      summaryData,
      toast,
    ]
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => handleTableKeyDown(e);
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [
    selectedRowKey,
    summaryData,
    expandedGroups,
    locationDialogOpen,
    selectedLocationIndex,
    selectedLocations,
    hiddenRows,
    handleTableKeyDown,
  ]);

  useEffect(() => {
    if (!tableScrollContainer.current) return;

    // Scroll to the focused location (horizontal)
    const colWidth = 60;
    const locationWidth = colWidth * 3 + 20;
    const scrollPosition = selectedLocationIndex * locationWidth;

    tableScrollContainer.current.scrollLeft = scrollPosition;
  }, [selectedLocationIndex]);

  // Scroll to selected row when it changes (vertical)
  // Uses absolute positioning (offsetTop) to prevent animation stacking issues
  useEffect(() => {
    if (!selectedRowKey || !tableScrollContainer.current) return;

    const container = tableScrollContainer.current;
    const rowElement = container.querySelector(`[data-row-key="${selectedRowKey}"]`) as HTMLElement | null;
    if (!rowElement) return;

    // Get the sticky header height
    const thead = container.querySelector("thead") as HTMLElement | null;
    const headerHeight = thead ? thead.offsetHeight : 60;
    const scrollMargin = 8;

    // Uses absolute positions (offsetTop) instead of relative getBoundingClientRect
    // This prevents stacking issues when multiple scroll animations overlap
    const rowTop = rowElement.offsetTop;
    const rowBottom = rowTop + rowElement.offsetHeight;

    // Calculate visible viewport bounds
    const viewportTop = container.scrollTop + headerHeight + scrollMargin;
    const viewportBottom = container.scrollTop + container.clientHeight - scrollMargin;

    // Calculate target scroll position if row is outside viewport
    let targetScrollTop: number | null = null;

    if (rowTop < viewportTop) {
      // Row is above visible area - scroll up to show it just below header
      targetScrollTop = rowTop - headerHeight - scrollMargin;
    } else if (rowBottom > viewportBottom) {
      // Row is below visible area - scroll down to show it at bottom
      targetScrollTop = rowBottom - container.clientHeight + scrollMargin;
    }

    // Only scroll if needed, clamp to valid range
    if (targetScrollTop !== null) {
      const maxScroll = container.scrollHeight - container.clientHeight;
      const clampedTarget = Math.max(0, Math.min(targetScrollTop, maxScroll));
      container.scrollTop = clampedTarget;
    }
  }, [selectedRowKey, expandedGroups, hiddenRows]);

  return (
    <div className="w-full h-screen flex flex-col overflow-hidden" data-testid="location-summary-container">
      <div className="flex items-center justify-between gap-4 flex-wrap p-3 md:p-4 flex-shrink-0 border-b">
        <div>
          <PageHeader
            title="Location Summary"
            subtitle="Stock inventory across locations with expandable stock groups"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter" />
          <Dialog open={locationDialogOpen} onOpenChange={setLocationDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-configure-locations">
                <Settings2 className="h-4 w-4 mr-1" />
                Locations ({selectedLocations.length})
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Select Locations to Display</DialogTitle>
              </DialogHeader>
              <div className="space-y-1 max-h-80 overflow-y-auto">
                {locations.map((location: Location) => (
                  <div
                    key={location.id}
                    className="flex items-center gap-2 p-2 rounded hover-elevate"
                    data-testid={`checkbox-location-${location.id}`}
                  >
                    <Checkbox
                      id={`loc-${location.id}`}
                      checked={selectedLocationIds.includes(location.id)}
                      onCheckedChange={() => toggleLocation(location.id)}
                    />
                    <Label htmlFor={`loc-${location.id}`} className="flex-1 cursor-pointer text-sm">
                      {location.name}
                    </Label>
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedLocationIds([])}
                  data-testid="button-clear-locations"
                >
                  Clear All
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedLocationIds(locations.map((l) => l.id))}
                  data-testid="button-select-all-locations"
                >
                  Select All
                </Button>
                <Button size="sm" onClick={() => setLocationDialogOpen(false)} data-testid="button-done-locations">
                  Done
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {selectedLocations.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Select locations to view inventory summary</p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => setLocationDialogOpen(true)}
              data-testid="button-add-locations-empty"
            >
              <Settings2 className="h-4 w-4 mr-1" />
              Configure Locations
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden flex flex-col flex-1 w-full m-4 mt-0" style={{ minHeight: 0 }}>
          <div className="overflow-auto flex-1" ref={tableScrollContainer} onPointerMove={handlePointerMove}>
            <table {...mobileCards.tableProps} className="w-full border-collapse" style={{ fontSize: "12px" }}>
              <thead className="sticky top-0 z-20 bg-muted">
                <tr className="bg-muted">
                  <th
                    className="text-left py-1 px-2 font-semibold border-b border-r sticky left-0 bg-muted z-30"
                    rowSpan={2}
                    style={{ minWidth: "200px", maxWidth: "250px" }}
                  >
                    Particulars
                  </th>
                  {selectedLocations.map((location, _locIndex) => (
                    <th
                      key={location.id}
                      colSpan={3}
                      className="text-center py-2 px-2 font-semibold border-b border-r bg-muted"
                    >
                      <span className="truncate block" title={location.name}>
                        {location.name}
                      </span>
                    </th>
                  ))}
                </tr>
                <tr className="bg-muted/80">
                  {selectedLocations.map((location, _locIndex) => (
                    <Fragment key={`header-${location.id}`}>
                      <th
                        className="text-right py-1 px-2 font-medium border-b bg-muted/80"
                        style={{ minWidth: "90px" }}
                      >
                        Qty (BL)
                      </th>
                      <th
                        className="text-right py-1 px-2 font-medium border-b bg-muted/80"
                        style={{ minWidth: "80px" }}
                      >
                        Rate ($)
                      </th>
                      <th
                        className="text-right py-1 px-2 font-medium border-b border-r bg-muted/80"
                        style={{ minWidth: "90px" }}
                      >
                        Value ($)
                      </th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={totalCols} className="p-8 text-center text-muted-foreground text-sm">
                      Loading...
                    </td>
                  </tr>
                ) : !summaryData?.stockGroups?.length ? (
                  <tr>
                    <td colSpan={totalCols} className="p-8 text-center text-muted-foreground text-sm">
                      No inventory data found for selected locations
                    </td>
                  </tr>
                ) : (
                  <>
                    {summaryData.stockGroups.map((group, groupIndex) => (
                      <Fragment key={`group-${group.id}`}>
                        <tr
                          className={cn(
                            "cursor-pointer",
                            highlightedRows.has(buildRowKey(group.id))
                              ? "bg-blue-400 dark:bg-blue-800"
                              : "bg-accent/30 hover:bg-accent/50",
                            groupIndex > 0 && "border-t",
                            selectedRowKey === buildRowKey(group.id) && "ring-2 ring-primary",
                            hiddenRows.has(buildRowKey(group.id)) && "hidden"
                          )}
                          onClick={() => {
                            toggleGroup(group.id);
                            setSelectedRowKey(buildRowKey(group.id));
                          }}
                          onMouseEnter={() => handleMouseEnterRow(buildRowKey(group.id))}
                          data-testid={`row-group-${group.id}`}
                          data-row-key={buildRowKey(group.id)}
                        >
                          <td
                            className={cn(
                              "py-1 px-2 border-r sticky left-0 z-10 font-semibold text-xs",
                              highlightedRows.has(buildRowKey(group.id))
                                ? "bg-blue-400 dark:bg-blue-800"
                                : "bg-accent/30"
                            )}
                          >
                            <div className="flex items-center gap-1">
                              {expandedGroups.has(group.id) ? (
                                <ChevronDown className="h-3 w-3 flex-shrink-0" />
                              ) : (
                                <ChevronRight className="h-3 w-3 flex-shrink-0" />
                              )}
                              <span className="truncate">{group.name}</span>
                            </div>
                          </td>
                          {selectedLocations.map((location, locIndex) => {
                            const data = group.locationData[location.id] || { quantity: 0, rate: 0, value: 0 };
                            const isSelectedCell =
                              locIndex === selectedLocationIndex && selectedRowKey === buildRowKey(group.id);
                            return (
                              <Fragment key={`group-${group.id}-loc-${location.id}`}>
                                <td
                                  className={cn(
                                    "text-right py-1 px-2 tabular-nums font-medium text-xs",
                                    isSelectedCell && "bg-blue-200 dark:bg-blue-800"
                                  )}
                                >
                                  {formatNumber(data.quantity, 0, "BL")}
                                </td>
                                <td
                                  className={cn(
                                    "text-right py-1 px-2 tabular-nums text-foreground text-xs",
                                    isSelectedCell && "bg-blue-200 dark:bg-blue-800"
                                  )}
                                >
                                  {data.rate === 0 ? "" : formatAmount(data.rate)}
                                </td>
                                <td
                                  className={cn(
                                    "text-right py-1 px-2 border-r tabular-nums font-semibold text-xs",
                                    isSelectedCell && "bg-blue-200 dark:bg-blue-800"
                                  )}
                                >
                                  {data.value === 0 ? "" : formatAmount(data.value)}
                                </td>
                              </Fragment>
                            );
                          })}
                        </tr>
                        {expandedGroups.has(group.id) &&
                          [...group.items]
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map((item, itemIndex) => (
                              <tr
                                key={`item-${item.id}`}
                                className={cn(
                                  highlightedRows.has(buildRowKey(group.id, item.id))
                                    ? "bg-blue-300 dark:bg-blue-700"
                                    : itemIndex % 2 === 0
                                      ? "bg-background"
                                      : "bg-muted/30",
                                  "hover:bg-accent/20 cursor-pointer",
                                  selectedRowKey === buildRowKey(group.id, item.id) && "ring-2 ring-primary",
                                  hiddenRows.has(buildRowKey(group.id, item.id)) && "hidden"
                                )}
                                onClick={() => setSelectedRowKey(buildRowKey(group.id, item.id))}
                                onMouseEnter={() => handleMouseEnterRow(buildRowKey(group.id, item.id))}
                                data-testid={`row-item-${item.id}`}
                                data-row-key={buildRowKey(group.id, item.id)}
                              >
                                <td
                                  className={cn(
                                    "py-0.5 pl-6 pr-2 border-r sticky left-0 z-10 cursor-pointer hover:underline text-xs",
                                    highlightedRows.has(buildRowKey(group.id, item.id))
                                      ? "bg-blue-300 dark:bg-blue-700"
                                      : itemIndex % 2 === 0
                                        ? "bg-background"
                                        : "bg-muted/30"
                                  )}
                                >
                                  <span
                                    className="text-blue-500 dark:text-blue-400 truncate block"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigate(`/stock-items/${item.id}/monthly-summary`);
                                    }}
                                    data-testid={`link-item-${item.id}`}
                                  >
                                    {item.name}
                                  </span>
                                </td>
                                {selectedLocations.map((location, locIndex) => {
                                  const data = item.locationData[location.id] || { quantity: 0, rate: 0, value: 0 };
                                  const isSelectedCell =
                                    locIndex === selectedLocationIndex &&
                                    selectedRowKey === buildRowKey(group.id, item.id);
                                  const isHighlighted = highlightedRows.has(buildRowKey(group.id, item.id));
                                  return (
                                    <Fragment key={`item-${item.id}-loc-${location.id}`}>
                                      <td
                                        className={cn(
                                          "text-right py-0.5 px-2 tabular-nums cursor-pointer hover:bg-accent/30 text-xs",
                                          isSelectedCell && !isHighlighted && "bg-blue-200 dark:bg-blue-800"
                                        )}
                                        onClick={() =>
                                          navigate(`/locations/${location.id}/stock-items/${item.id}/history`)
                                        }
                                        data-testid={`cell-qty-${item.id}-${location.id}`}
                                      >
                                        {formatNumber(data.quantity, 0, "BL")}
                                      </td>
                                      <td
                                        className={cn(
                                          "text-right py-0.5 px-2 tabular-nums text-foreground cursor-pointer hover:bg-accent/30 text-xs",
                                          isSelectedCell && !isHighlighted && "bg-blue-200 dark:bg-blue-800"
                                        )}
                                        onClick={() =>
                                          navigate(`/locations/${location.id}/stock-items/${item.id}/history`)
                                        }
                                        data-testid={`cell-rate-${item.id}-${location.id}`}
                                      >
                                        {data.rate === 0 ? "" : formatAmount(data.rate)}
                                      </td>
                                      <td
                                        className={cn(
                                          "text-right py-0.5 px-2 border-r tabular-nums cursor-pointer hover:bg-accent/30 text-xs",
                                          isSelectedCell && !isHighlighted && "bg-blue-200 dark:bg-blue-800"
                                        )}
                                        onClick={() =>
                                          navigate(`/locations/${location.id}/stock-items/${item.id}/history`)
                                        }
                                        data-testid={`cell-value-${item.id}-${location.id}`}
                                      >
                                        {data.value === 0 ? "" : formatAmount(data.value)}
                                      </td>
                                    </Fragment>
                                  );
                                })}
                              </tr>
                            ))}
                      </Fragment>
                    ))}
                    <tr className="font-bold bg-primary/10 border-t-2 border-primary/30 text-xs">
                      <td className="py-1 px-2 border-r sticky left-0 bg-primary/10 text-primary z-10">
                        Grand Total (by Location)
                      </td>
                      {selectedLocations.map((location, _locIndex) => {
                        const data = summaryData.grandTotals[location.id] || { quantity: 0, rate: 0, value: 0 };
                        return (
                          <Fragment key={`grand-${location.id}`}>
                            <td
                              className="text-right py-1 px-2 tabular-nums"
                              data-testid={`text-grand-qty-${location.id}`}
                            >
                              {formatNumber(data.quantity, 0, "BL")}
                            </td>
                            <td className="text-right py-1 px-2 tabular-nums text-foreground">
                              {data.rate === 0 ? "" : formatAmount(data.rate)}
                            </td>
                            <td
                              className="text-right py-1 px-2 border-r tabular-nums"
                              data-testid={`text-grand-value-${location.id}`}
                            >
                              {data.value === 0 ? "" : formatAmount(data.value)}
                            </td>
                          </Fragment>
                        );
                      })}
                    </tr>
                    <tr className="font-bold bg-green-100 dark:bg-green-900/40 border-t text-xs">
                      <td className="py-1 px-2 border-r sticky left-0 bg-green-100 dark:bg-green-900/40 text-green-900 dark:text-green-100 z-10">
                        Total (All Locations)
                      </td>
                      {selectedLocations.map((location) => {
                        const totalQty = selectedLocations.reduce((sum, loc) => {
                          const data = summaryData.grandTotals[loc.id] || { quantity: 0, rate: 0, value: 0 };
                          return sum + data.quantity;
                        }, 0);
                        const totalValue = selectedLocations.reduce((sum, loc) => {
                          const data = summaryData.grandTotals[loc.id] || { quantity: 0, rate: 0, value: 0 };
                          return sum + data.value;
                        }, 0);
                        const avgRate = totalQty > 0 ? totalValue / totalQty : 0;
                        return (
                          <Fragment key={`total-all-${location.id}`}>
                            <td className="text-right py-1 px-2 tabular-nums" data-testid="text-total-all-qty">
                              {formatNumber(totalQty, 0, "BL")}
                            </td>
                            <td
                              className="text-right py-1 px-2 tabular-nums text-foreground"
                              data-testid="text-total-all-rate"
                            >
                              {avgRate === 0 ? "" : formatAmount(avgRate)}
                            </td>
                            <td
                              className="text-right py-1 px-2 border-r tabular-nums"
                              data-testid="text-total-all-value"
                            >
                              {formatAmount(totalValue)}
                            </td>
                          </Fragment>
                        );
                      })}
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
