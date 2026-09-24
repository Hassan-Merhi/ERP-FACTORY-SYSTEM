import { searchAny } from "@shared/searchNormalization";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Tag, Search, Printer, CheckSquare, Square, MapPin, Package, X, ChevronDown, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { isZebraMode, printRawZpl } from "@/lib/zebraPrint";
import { buildZplBatch } from "@/lib/zplBuilder";
import { LabelPrintSettings, getPaperFormat } from "@/components/LabelPrintSettings";
import {
  generateCombinedLabelsHtml,
  generateA5LabelsHtml,
  generateStickerLabelsHtml,
  prefetchBannersForPrint,
  type LabelData,
  type A4DesignColor,
} from "@/lib/labelHtml";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";

interface Location {
  id: number;
  code: string;
  name: string;
  city: string | null;
  country: string | null;
}

interface BaleRow {
  bale: {
    id: number;
    baleCode: string;
    referenceNumber: string;
    articleCode: string | null;
    productName: string | null;
    category: string | null;
    weightKg: string;
    quantity: number;
    status: string;
  };
  product: {
    id: number;
    articleCode: string;
    name: string;
  } | null;
}

export default function FactoryReprintLabels() {
  const { toast } = useToast();
  const { colors } = useLabelDesignColors();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  const [selectedLocationId, setSelectedLocationId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [articleCodeFilters, setArticleCodeFilters] = useState<Set<string>>(new Set());
  const [articleCodeSearch, setArticleCodeSearch] = useState("");
  const [articlePickerOpen, setArticlePickerOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const [designPickerOpen, setDesignPickerOpen] = useState(false);
  const [pendingLabels, setPendingLabels] = useState<LabelData[]>([]);

  const { data: locations = [], isLoading: locationsLoading } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: balesData = [], isLoading: balesLoading } = useQuery<BaleRow[]>({
    queryKey: ["/api/factory/bales", selectedLocationId],
    queryFn: async () => {
      if (!selectedLocationId) return [];
      const res = await fetch(`/api/factory/bales?locationId=${selectedLocationId}&status=IN_STOCK`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch bales");
      return res.json();
    },
    enabled: !!selectedLocationId,
  });

  const uniqueArticleCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const row of balesData) {
      const code = row.product?.articleCode || row.bale.articleCode || "";
      if (code) codes.add(code);
    }
    return Array.from(codes).sort();
  }, [balesData]);

  const filteredBales = useMemo(() => {
    return balesData.filter((row) => {
      const artCode = row.product?.articleCode || row.bale.articleCode || "";
      if (articleCodeFilters.size > 0 && !articleCodeFilters.has(artCode)) return false;
      if (!search.trim()) return true;
      const term = search.toLowerCase();
      const refNum = (row.bale.referenceNumber || "").toLowerCase();
      const baleCode = (row.bale.baleCode || "").toLowerCase();
      const prodName = (row.bale.productName || row.product?.name || "").toLowerCase();
      return (
        refNum.includes(term) ||
        baleCode.includes(term) ||
        prodName.includes(term) ||
        artCode.toLowerCase().includes(term)
      );
    });
  }, [balesData, search, articleCodeFilters]);

  const selectedLocation = locations.find((l) => String(l.id) === selectedLocationId);

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(filteredBales.map((r) => r.bale.id)));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  const openBrowserPrint = (labels: LabelData[], designColor?: A4DesignColor) => {
    prefetchBannersForPrint();
    const fmt = getPaperFormat();
    if (fmt === "A4" && !designColor) {
      setPendingLabels(labels);
      setDesignPickerOpen(true);
      return;
    }
    const paperHtml = fmt === "A5" ? generateA5LabelsHtml(labels) : generateCombinedLabelsHtml(labels, designColor);
    const stickerHtml = generateStickerLabelsHtml(labels);

    const w1 = window.open("", "_blank", "width=800,height=900");
    if (w1) {
      w1.document.write(paperHtml);
      w1.document.close();
      w1.focus();
      setTimeout(() => w1.print(), 500);
    }
    const w2 = window.open("", "_blank", "width=400,height=600");
    if (w2) {
      w2.document.write(stickerHtml);
      w2.document.close();
      w2.focus();
      const imgs = w2.document.images;
      let loaded = 0;
      const total = imgs.length;
      const tryPrint = () => {
        loaded++;
        if (loaded >= total) setTimeout(() => w2.print(), 300);
      };
      if (total === 0) {
        setTimeout(() => w2.print(), 300);
      } else {
        for (let i = 0; i < total; i++) {
          if (imgs[i].complete) tryPrint();
          else imgs[i].onload = imgs[i].onerror = tryPrint;
        }
      }
    }
    if (!w1 && !w2) {
      toast({ title: "Warning", description: "Please allow pop-ups to print labels", variant: "destructive" });
    }
  };

  const handlePrint = async () => {
    const rowsToPrint = filteredBales.filter((r) => selectedIds.has(r.bale.id));
    if (rowsToPrint.length === 0) {
      toast({ title: "Nothing selected", description: "Tick at least one bale to print.", variant: "destructive" });
      return;
    }

    const labels: LabelData[] = rowsToPrint.map((row) => ({
      referenceNumber: row.bale.referenceNumber || row.bale.baleCode,
      articleCode: row.product?.articleCode || row.bale.articleCode || row.bale.category || "",
      pieces: row.bale.quantity || 1,
      approxWeightKg: row.bale.weightKg || "0",
      productName: row.bale.productName || row.product?.name || row.bale.category || "",
    }));

    for (const row of rowsToPrint) {
      try {
        await modeApiRequest("POST", "/api/bale-label-prints/reprint", { baleId: row.bale.id });
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }
    }

    if (isZebraMode()) {
      try {
        const zpl = buildZplBatch(labels, true);
        await printRawZpl(zpl);
        toast({ title: `${labels.length} label(s) sent to Zebra printer` });
      } catch (err) {
        toast({
          title: "Zebra print failed — falling back to browser",
          description: getErrorDetails(err).message,
          variant: "destructive",
        });
        openBrowserPrint(labels);
      }
    } else {
      openBrowserPrint(labels);
    }
  };

  const allFilteredSelected = filteredBales.length > 0 && filteredBales.every((r) => selectedIds.has(r.bale.id));

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
        <>
          {/* Search bar + actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Filter by bale name or reference…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
                data-testid="input-search-bales"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  data-testid="button-clear-search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <Popover open={articlePickerOpen} onOpenChange={setArticlePickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="default" className="gap-2" data-testid="button-article-code-filter">
                  <Filter className="h-4 w-4" />
                  {articleCodeFilters.size === 0 ? "Article code" : `${articleCodeFilters.size} selected`}
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-2" align="start">
                <div className="relative mb-2">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    placeholder="Search article codes…"
                    value={articleCodeSearch}
                    onChange={(e) => setArticleCodeSearch(e.target.value)}
                    className="pl-7 h-8 text-sm"
                    data-testid="input-article-code-search"
                  />
                  {articleCodeSearch && (
                    <button
                      onClick={() => setArticleCodeSearch("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {articleCodeFilters.size > 0 && (
                  <button
                    onClick={() => setArticleCodeFilters(new Set())}
                    className="text-xs text-muted-foreground hover:text-foreground mb-2 w-full text-left"
                    data-testid="button-clear-article-filters"
                  >
                    Clear all ({articleCodeFilters.size})
                  </button>
                )}

                <div className="max-h-52 overflow-y-auto space-y-0.5">
                  {uniqueArticleCodes
                    .filter(
                      (c) => !articleCodeSearch.trim() || searchAny(articleCodeSearch, c)
                    )
                    .map((code) => (
                      <label
                        key={code}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer hover-elevate text-sm"
                        data-testid={`option-article-${code}`}
                      >
                        <Checkbox
                          checked={articleCodeFilters.has(code)}
                          onCheckedChange={(checked) => {
                            setArticleCodeFilters((prev) => {
                              const next = new Set(prev);
                              if (checked) next.add(code);
                              else next.delete(code);
                              return next;
                            });
                          }}
                          data-testid={`checkbox-article-${code}`}
                        />
                        <span>{code}</span>
                      </label>
                    ))}
                  {uniqueArticleCodes.filter(
                    (c) => !articleCodeSearch.trim() || searchAny(articleCodeSearch, c)
                  ).length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-2">No article codes found</p>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            <Button
              variant="outline"
              size="sm"
              onClick={allFilteredSelected ? deselectAll : selectAll}
              disabled={filteredBales.length === 0}
              data-testid="button-select-all"
            >
              {allFilteredSelected ? (
                <>
                  <Square className="h-4 w-4 mr-1.5" /> Deselect All
                </>
              ) : (
                <>
                  <CheckSquare className="h-4 w-4 mr-1.5" /> Select All
                </>
              )}
            </Button>

            <Button
              size="sm"
              onClick={handlePrint}
              disabled={selectedIds.size === 0 || balesLoading}
              data-testid="button-print-selected"
            >
              <Printer className="h-4 w-4 mr-1.5" />
              Print {selectedIds.size > 0 ? `${selectedIds.size} Label(s)` : "Selected"}
            </Button>
          </div>

          {/* Active article code filter chips */}
          {articleCodeFilters.size > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-muted-foreground">Filtering by:</span>
              {Array.from(articleCodeFilters).map((code) => (
                <Badge
                  key={code}
                  variant="secondary"
                  className="gap-1 cursor-pointer"
                  onClick={() =>
                    setArticleCodeFilters((prev) => {
                      const next = new Set(prev);
                      next.delete(code);
                      return next;
                    })
                  }
                  data-testid={`chip-article-${code}`}
                >
                  {code}
                  <X className="h-3 w-3" />
                </Badge>
              ))}
              <button
                onClick={() => setArticleCodeFilters(new Set())}
                className="text-xs text-muted-foreground hover:text-foreground"
                data-testid="button-clear-all-chips"
              >
                Clear all
              </button>
            </div>
          )}

          {/* Bale list */}
          {balesLoading ? (
            <div className="space-y-2">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredBales.length === 0 ? (
            <Card className="p-8 text-center text-muted-foreground">
              <Package className="h-8 w-8 mx-auto mb-2 opacity-40" />
              {balesData.length === 0 ? "No bales in stock at this location." : `No bales match "${search}".`}
            </Card>
          ) : (
            <>
              <div className="text-xs text-muted-foreground">
                Showing {filteredBales.length} of {balesData.length} bales
                {selectedIds.size > 0 && (
                  <span className="ml-2 font-medium text-foreground">· {selectedIds.size} selected</span>
                )}
              </div>

              {/* Desktop table */}
              <div className="hidden sm:block rounded-md border overflow-x-auto">
                <table className="text-sm w-full">
                  <thead className="sticky top-0 z-30 bg-muted/50">
                    <tr className="h-10">
                      <th className="w-10 px-3"></th>
                      <th className="text-left px-3 font-medium">Reference No.</th>
                      <th className="text-left px-3 font-medium">Bale Name</th>
                      <th className="text-left px-3 font-medium">Article Code</th>
                      <th className="text-right px-3 font-medium">Weight (KG)</th>
                      <th className="text-right px-3 font-medium">Pcs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredBales.map((row) => {
                      const checked = selectedIds.has(row.bale.id);
                      const articleCode = row.product?.articleCode || row.bale.articleCode || row.bale.category || "-";
                      const prodName = row.bale.productName || row.product?.name || row.bale.category || "-";
                      return (
                        <tr
                          key={row.bale.id}
                          className={`border-t h-11 cursor-pointer transition-colors ${checked ? "bg-primary/5" : "hover:bg-muted/30"}`}
                          onClick={() => toggleSelect(row.bale.id)}
                          data-testid={`row-bale-${row.bale.id}`}
                        >
                          <td className="px-3 text-center">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => toggleSelect(row.bale.id)}
                              data-testid={`checkbox-bale-${row.bale.id}`}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td className="px-3 font-mono text-xs text-muted-foreground">
                            {row.bale.referenceNumber || row.bale.baleCode}
                          </td>
                          <td className="px-3 font-medium">{prodName}</td>
                          <td className="px-3 font-mono text-xs text-muted-foreground">{articleCode}</td>
                          <td className="px-3 text-right font-mono">
                            {parseFloat(row.bale.weightKg).toLocaleString(undefined, {
                              minimumFractionDigits: 1,
                              maximumFractionDigits: 1,
                            })}
                          </td>
                          <td className="px-3 text-right font-mono">{row.bale.quantity}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="sm:hidden space-y-2">
                {filteredBales.map((row) => {
                  const checked = selectedIds.has(row.bale.id);
                  const articleCode = row.product?.articleCode || row.bale.articleCode || row.bale.category || "-";
                  const prodName = row.bale.productName || row.product?.name || row.bale.category || "-";
                  return (
                    <Card
                      key={row.bale.id}
                      className={`p-3 cursor-pointer transition-colors ${checked ? "ring-2 ring-primary" : ""}`}
                      onClick={() => toggleSelect(row.bale.id)}
                      data-testid={`card-bale-${row.bale.id}`}
                    >
                      <div className="flex items-start gap-2">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleSelect(row.bale.id)}
                          data-testid={`checkbox-bale-mobile-${row.bale.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{prodName}</div>
                          <div className="text-xs text-muted-foreground font-mono mt-0.5">
                            {row.bale.referenceNumber || row.bale.baleCode}
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            <span>{articleCode}</span>
                            <span>
                              {parseFloat(row.bale.weightKg).toLocaleString(undefined, {
                                minimumFractionDigits: 1,
                                maximumFractionDigits: 1,
                              })}{" "}
                              KG
                            </span>
                            <span>{row.bale.quantity} pc(s)</span>
                          </div>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </>
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
                  className="inline-block h-2.5 w-2.5 rounded-full mr-2 flex-shrink-0 border border-border/50"
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
