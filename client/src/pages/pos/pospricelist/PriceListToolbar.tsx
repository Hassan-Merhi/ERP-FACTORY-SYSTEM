/**
 * Header controls for the POS Price List page: the title bar with the
 * template/upload/export actions, the All-mode location visibility strip, the
 * search + group filter row and the unpriced-group chips.
 *
 * Split out of POSPriceList.tsx unchanged, including the POS-user gates on
 * editing actions and the fact that toggling "Unpriced" resets the group
 * filter and unhides every group.
 */
import { Download, Eye, EyeOff, FileSpreadsheet, Layers, MapPin, Search, Tag, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/PageHeader";
import type { PosPriceListModel } from "./usePosPriceListModel";

export function PriceListTitleBar({ model }: { model: PosPriceListModel }) {
  const { isAllMode, selectedLocation, selectedLocationId, canEdit, masters } = model;
  return (
    <div className="shrink-0 px-0 pt-3 sm:px-4">
      <PageHeader
        title="Price List"
        icon={<Tag className="h-4 w-4" />}
        meta={
          isAllMode ? (
            <Badge variant="secondary" className="gap-1 shrink-0">
              <Layers className="w-3 h-3" />
              All Locations
            </Badge>
          ) : selectedLocation ? (
            <Badge variant="secondary" className="gap-1 shrink-0">
              <MapPin className="w-3 h-3" />
              {selectedLocation.name}
            </Badge>
          ) : null
        }
      >
        {selectedLocationId && isAllMode && canEdit && (
          <Button
            variant="outline"
            size="sm"
            data-testid="button-download-price-template"
            onClick={model.downloadTemplate}
            disabled={masters.length === 0}
            className="gap-1.5"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Template
          </Button>
        )}
        {selectedLocationId && isAllMode && canEdit && (
          <Button
            variant="outline"
            size="sm"
            data-testid="button-upload-price-list"
            onClick={model.openImportFilePicker}
            className="gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" />
            Upload
          </Button>
        )}
        {selectedLocationId && (
          <Button
            variant="outline"
            size="sm"
            data-testid="button-export-price-list"
            onClick={model.exportToExcel}
            disabled={model.exporting || model.filteredItems.length === 0}
            className="gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            {model.exporting ? "Exporting…" : "Export"}
          </Button>
        )}
      </PageHeader>
      {isAllMode && canEdit && (
        <input
          ref={model.importFileRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={model.handleImportFile}
          data-testid="input-import-price-file"
        />
      )}
    </div>
  );
}

export function PriceListLocationVisibility({ model }: { model: PosPriceListModel }) {
  const { isAllMode, selectedLocationId, masters, hiddenLocations } = model;
  if (!isAllMode || !selectedLocationId) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5 border-b shrink-0">
      <span className="text-xs font-medium text-muted-foreground shrink-0">Locations</span>
      <div className="w-px h-3.5 bg-border shrink-0" />
      <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
        {masters.map((m) => {
          const isHidden = hiddenLocations.has(m.id);
          return (
            <button
              key={m.id}
              data-testid={`chip-location-${m.id}`}
              onClick={() => model.toggleHiddenLocation(m.id)}
              className={cn(
                "inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium border transition-all",
                isHidden
                  ? "bg-muted/40 text-muted-foreground border-transparent opacity-50"
                  : "bg-muted text-foreground border-transparent hover-elevate"
              )}
            >
              {isHidden ? <EyeOff className="w-3 h-3 mr-1 opacity-60" /> : null}
              {m.name}
            </button>
          );
        })}
      </div>
      <div className="flex gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs px-2 text-muted-foreground"
          onClick={() => model.setHiddenLocations(new Set())}
          data-testid="button-show-all-locations"
        >
          <Eye className="w-3 h-3 mr-1" />
          Show All
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs px-2 text-muted-foreground"
          onClick={() => model.setHiddenLocations(new Set(masters.map((m) => m.id)))}
          data-testid="button-hide-all-locations"
        >
          <EyeOff className="w-3 h-3 mr-1" />
          Hide All
        </Button>
      </div>
    </div>
  );
}

export function PriceListSearchRow({ model }: { model: PosPriceListModel }) {
  const { selectedLocationId, stockGroups, showUnpriced, canEdit, unpricedCount } = model;
  if (!selectedLocationId) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b shrink-0">
      <div className="relative flex-1 min-w-[180px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <Input
          data-testid="input-price-search"
          className="pl-9 h-9"
          placeholder="Search by name or code…"
          value={model.search}
          onChange={(e) => model.setSearch(e.target.value)}
        />
      </div>
      {stockGroups.length > 0 && !showUnpriced && (
        <Select value={model.groupFilter} onValueChange={model.setGroupFilter}>
          <SelectTrigger data-testid="select-group-filter" className="w-40 h-9">
            <SelectValue placeholder="All groups" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All groups</SelectItem>
            {stockGroups.map((g) => (
              <SelectItem key={g} value={g}>
                {g}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {canEdit && (
        <button
          data-testid="button-show-unpriced"
          onClick={model.toggleUnpriced}
          className={cn(
            "inline-flex items-center gap-2 h-9 px-3 rounded-md text-sm font-medium border transition-colors shrink-0",
            showUnpriced
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-muted/60 text-foreground border-transparent hover-elevate"
          )}
        >
          <EyeOff className="w-3.5 h-3.5" />
          Unpriced
          {unpricedCount > 0 && (
            <span
              className={cn(
                "inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded text-[11px] font-semibold",
                showUnpriced ? "bg-primary-foreground/20 text-primary-foreground" : "bg-foreground/10 text-foreground"
              )}
            >
              {unpricedCount}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

export function PriceListUnpricedGroups({ model }: { model: PosPriceListModel }) {
  const { selectedLocationId, showUnpriced, unpricedByGroup, hiddenUnpricedGroups } = model;
  if (!selectedLocationId || !showUnpriced || unpricedByGroup.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5 border-b shrink-0">
      <span className="text-xs font-medium text-muted-foreground shrink-0">Groups</span>
      <div className="w-px h-3.5 bg-border shrink-0" />
      <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
        {unpricedByGroup.map(({ name, count }) => {
          const isHidden = hiddenUnpricedGroups.has(name);
          return (
            <button
              key={name}
              data-testid={`chip-unpriced-group-${name}`}
              onClick={() => model.toggleHiddenUnpricedGroup(name)}
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-all",
                isHidden
                  ? "bg-muted/40 text-muted-foreground border-transparent opacity-50"
                  : "bg-muted text-foreground border-transparent hover-elevate"
              )}
            >
              <span>{name}</span>
              <span
                className={cn(
                  "inline-flex items-center justify-center min-w-[1.1rem] h-4 px-1 rounded text-[10px] font-bold",
                  isHidden
                    ? "bg-muted-foreground/15 text-muted-foreground"
                    : "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs px-2 text-muted-foreground"
          onClick={() => model.setHiddenUnpricedGroups(new Set())}
          data-testid="button-show-all-unpriced-groups"
        >
          <Eye className="w-3 h-3 mr-1" />
          Show All
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs px-2 text-muted-foreground"
          onClick={() => model.setHiddenUnpricedGroups(new Set(unpricedByGroup.map((g) => g.name)))}
          data-testid="button-hide-all-unpriced-groups"
        >
          <EyeOff className="w-3 h-3 mr-1" />
          Hide All
        </Button>
      </div>
    </div>
  );
}
