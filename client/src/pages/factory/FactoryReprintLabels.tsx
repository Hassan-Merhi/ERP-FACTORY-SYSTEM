import { PageHeader } from "@/components/PageHeader";
import { Tag, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { LabelPrintSettings } from "@/components/LabelPrintSettings";
import { useFactoryReprintLabelsState } from "./useFactoryReprintLabelsState";
import { FactoryReprintLabelsSection } from "./FactoryReprintLabelsSection";

export default function FactoryReprintLabels() {
  const {
    refetchBales,
    balesError,
    allFilteredSelected,
    articleCodeFilters,
    articleCodeSearch,
    articlePickerOpen,
    balesData,
    balesLoading,
    colors,
    deselectAll,
    designPickerOpen,
    filteredBales,
    handlePrint,
    locations,
    locationsLoading,
    openBrowserPrint,
    pendingLabels,
    recordChanges,
    search,
    selectAll,
    selectedIds,
    selectedLocation,
    selectedLocationId,
    setArticleCodeFilters,
    setArticleCodeSearch,
    setArticlePickerOpen,
    setDesignPickerOpen,
    setSearch,
    setSelectedIds,
    setSelectedLocationId,
    toggleSelect,
    uniqueArticleCodes,
  } = useFactoryReprintLabelsState();

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <PageHeader title="Reprint Labels" icon={<Tag className="h-5 w-5" />} />
          <p className="text-sm text-muted-foreground mt-0.5">
            Select a location, filter bales by name or reference, then print selected labels.
          </p>
        </div>
        <LabelPrintSettings />
      </div>

      {/* Location picker */}
      <Card className="p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium">Location:</span>
          <Select
            value={selectedLocationId}
            onValueChange={(val) => {
              setSelectedLocationId(val);
              setSelectedIds(new Set());
              setSearch("");
              setArticleCodeFilters(new Set());
              setArticleCodeSearch("");
            }}
            data-testid="select-location"
          >
            <SelectTrigger className="w-[240px]" data-testid="select-location-trigger">
              <SelectValue placeholder="Choose a location…" />
            </SelectTrigger>
            <SelectContent>
              {locationsLoading ? (
                <SelectItem value="__loading__" disabled>
                  Loading…
                </SelectItem>
              ) : (
                locations.map((loc) => (
                  <SelectItem key={loc.id} value={String(loc.id)} data-testid={`option-location-${loc.id}`}>
                    {loc.name}
                    {loc.city ? ` — ${loc.city}` : ""}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {selectedLocation && (
            <Badge variant="secondary" className="text-xs">
              {balesLoading ? "Loading…" : `${balesData.length} bale(s) in stock`}
            </Badge>
          )}
        </div>
      </Card>

      {/* Only show content once a location is picked */}
      {selectedLocationId && (
        <FactoryReprintLabelsSection
          refetchBales={refetchBales}
          balesError={balesError}
          allFilteredSelected={allFilteredSelected}
          articleCodeFilters={articleCodeFilters}
          articleCodeSearch={articleCodeSearch}
          articlePickerOpen={articlePickerOpen}
          balesData={balesData}
          balesLoading={balesLoading}
          deselectAll={deselectAll}
          filteredBales={filteredBales}
          handlePrint={handlePrint}
          recordChanges={recordChanges}
          search={search}
          selectAll={selectAll}
          selectedIds={selectedIds}
          setArticleCodeFilters={setArticleCodeFilters}
          setArticleCodeSearch={setArticleCodeSearch}
          setArticlePickerOpen={setArticlePickerOpen}
          setSearch={setSearch}
          toggleSelect={toggleSelect}
          uniqueArticleCodes={uniqueArticleCodes}
        />
      )}

      {/* A4 design picker dialog */}
      <Dialog open={designPickerOpen} onOpenChange={setDesignPickerOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Choose A4 Label Design</DialogTitle>
            <DialogDescription>Pick a color design for the A4 label sheet.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 py-2">
            {colors.map((opt) => (
              <Button
                key={opt.value}
                variant="outline"
                onClick={() => {
                  setDesignPickerOpen(false);
                  openBrowserPrint(pendingLabels, opt.value);
                }}
                data-testid={`button-design-${opt.value}`}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full mr-2 shrink-0 border border-border/50"
                  style={{ background: opt.color }}
                />
                {opt.label}
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDesignPickerOpen(false)} data-testid="button-design-cancel">
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
