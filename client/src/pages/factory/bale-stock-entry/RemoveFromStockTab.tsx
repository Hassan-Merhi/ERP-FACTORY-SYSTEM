import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Trash2, List, LayoutList, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { isZebraMode, printRawZpl } from "@/lib/zebraPrint";
import { buildZplBatch } from "@/lib/zplBuilder";
import { getPaperFormat } from "@/components/LabelPrintSettings";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import {
  generateCombinedLabelsHtml,
  generateA5LabelsHtml,
  generateStickerLabelsHtml,
  prefetchBannersForPrint,
  type LabelData,
  type A4DesignColor,
} from "@/lib/labelHtml";
import type { FactoryBaleProduct, Location } from "@shared/schema";
import { RemoveBaleAuthDialog, AssignWorkerDialog } from "./RemoveFromStockDialogs";
import { RemoveFromStockTable } from "./RemoveFromStockTable";

export interface WorkerOption {
  id: number;
  active?: boolean | null;
  fullName?: string | null;
  name?: string | null;
}

export interface InStockBale {
  id: number;
  productId: number;
  articleCode?: string | null;
  productName?: string | null;
  weightKg: string;
  referenceNumber?: string | null;
  locationName?: string | null;
  finalizedAt?: string | null;
  finalizedBy?: number | null;
  finalizedByName?: string | null;
}

interface LabelPrintResult {
  referenceNumber: string;
  articleCode?: string | null;
  pieces?: number;
  approxWeightKg?: string | number | null;
}

export function RemoveFromStockTab() {
  const [selectedLocationId, setSelectedLocationId] = useState<string>("");
  const [dateFilter, setDateFilter] = useState<string>("");
  const [selectedBaleIds, setSelectedBaleIds] = useState<Set<number>>(new Set());
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [supervisorUsername, setSupervisorUsername] = useState("");
  const [supervisorPassword, setSupervisorPassword] = useState("");
  const [removalReason, setRemovalReason] = useState("");
  const [authError, setAuthError] = useState("");
  const [viewMode, setViewMode] = useState<"condensed" | "detailed">("condensed");
  const [_designPickerOpen, _setDesignPickerOpen] = useState(false);
  const [_pendingPrintLabels, _setPendingPrintLabels] = useState<LabelData[] | null>(null);
  const [printWorkerBale, setPrintWorkerBale] = useState<InStockBale | null>(null);
  const [printWorkerIdSelected, setPrintWorkerIdSelected] = useState<string>("");
  const [assigningWorker, setAssigningWorker] = useState(false);
  const { colors: _designColors } = useLabelDesignColors();
  const [_importingNames, setImportingNames] = useState(false);
  const [_reimporting, setReimporting] = useState(false);
  const namesFileRef = useRef<HTMLInputElement>(null);
  const reimportFileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { formatDisplayDate } = useDateFormat();

  const { data: workers = [] } = useQuery<WorkerOption[]>({ queryKey: ["/api/factory/workers"] });
  const { data: baleProducts } = useQuery<FactoryBaleProduct[]>({ queryKey: ["/api/factory/bale-products"] });

  const bulkUpdateNamesMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/factory/bales/bulk-update-names", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Names updated",
        description: `Updated ${data.updated} bale${data.updated !== 1 ? "s" : ""}, skipped ${data.skipped}.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"], refetchType: "active" });
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => setImportingNames(false),
  });

  const reimportMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/factory/bales/reimport", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Reimport failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Bales reimported",
        description: `Successfully reimported ${data.imported} bale(s) (${parseFloat(data.totalWeight).toFixed(1)} kg) with original reference numbers.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"], refetchType: "active" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock-entry/in-stock"] });
    },
    onError: (err: Error) => {
      toast({ title: "Reimport failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => setReimporting(false),
  });

  const openBrowserPrint = (labels: LabelData[], designColor?: A4DesignColor) => {
    prefetchBannersForPrint();
    const paperFormat = getPaperFormat();
    const labelsForA4 = designColor ? labels : labels.filter((l) => l.designColor);

    if (labelsForA4.length > 0) {
      const labelHtml =
        paperFormat === "A5" ? generateA5LabelsHtml(labelsForA4) : generateCombinedLabelsHtml(labelsForA4, designColor);
      const a4Window = window.open("", "_blank");
      if (a4Window) {
        a4Window.document.write(labelHtml);
        a4Window.document.close();
        a4Window.focus();
        const a4Imgs = a4Window.document.images;
        let a4Loaded = 0;
        const a4Total = a4Imgs.length;
        const tryA4Print = () => {
          a4Loaded++;
          if (a4Loaded >= a4Total) setTimeout(() => a4Window.print(), 200);
        };
        if (a4Total === 0) {
          setTimeout(() => a4Window.print(), 200);
        } else {
          for (let i = 0; i < a4Total; i++) {
            if (a4Imgs[i].complete) tryA4Print();
            else a4Imgs[i].onload = a4Imgs[i].onerror = tryA4Print;
          }
        }
      }
    }

    const stickerWindow = window.open("", "_blank");
    if (stickerWindow) {
      stickerWindow.document.write(generateStickerLabelsHtml(labels));
      stickerWindow.document.close();
      stickerWindow.focus();
      const imgs = stickerWindow.document.images;
      let loaded = 0;
      const total = imgs.length;
      const tryPrint = () => {
        loaded++;
        if (loaded >= total) setTimeout(() => stickerWindow.print(), 300);
      };
      if (total === 0) {
        setTimeout(() => stickerWindow.print(), 300);
      } else {
        for (let i = 0; i < total; i++) {
          if (imgs[i].complete) tryPrint();
          else imgs[i].onload = imgs[i].onerror = tryPrint;
        }
      }
    }
  };

  const printDirectNoDesign = (labels: LabelData[]) => {
    const stickerWindow = window.open("", "_blank");
    if (stickerWindow) {
      stickerWindow.document.write(generateStickerLabelsHtml(labels));
      stickerWindow.document.close();
      stickerWindow.focus();
      const imgs = stickerWindow.document.images;
      let loaded = 0;
      const total = imgs.length;
      const tryPrint = () => {
        loaded++;
        if (loaded >= total) setTimeout(() => stickerWindow.print(), 300);
      };
      if (total === 0) {
        setTimeout(() => stickerWindow.print(), 300);
      } else {
        for (let i = 0; i < total; i++) {
          if (imgs[i].complete) tryPrint();
          else imgs[i].onload = imgs[i].onerror = tryPrint;
        }
      }
    }
  };

  const printSingleBale = async (bale: InStockBale) => {
    try {
      const labelResponse = await modeApiRequest("POST", "/api/bale-label-prints", {
        bales: [
          {
            productionBaleId: bale.id,
            productId: bale.productId,
            articleCode: bale.articleCode || "",
            pieces: 1,
            approxWeightKg: bale.weightKg || "0",
          },
        ],
      });
      if (!labelResponse.ok) throw new Error("Failed to create label");
      const { labelPrints } = await labelResponse.json();
      const labels: LabelData[] = labelPrints.map((lp: LabelPrintResult) => ({
        referenceNumber: lp.referenceNumber,
        articleCode: lp.articleCode || bale.articleCode || "",
        pieces: lp.pieces || 1,
        approxWeightKg: lp.approxWeightKg || bale.weightKg || "0",
        productName: bale.productName || "",
      }));
      const product = baleProducts?.find((p) => p.id === bale.productId);
      const assignedColor = product?.labelDesignColor as A4DesignColor | null | undefined;
      if (isZebraMode()) {
        try {
          await printRawZpl(buildZplBatch(labels, true));
          toast({ title: "Label sent to Zebra printer" });
        } catch (_err) {
          if (assignedColor) openBrowserPrint(labels, assignedColor);
          else printDirectNoDesign(labels);
        }
      } else {
        if (assignedColor) openBrowserPrint(labels, assignedColor);
        else printDirectNoDesign(labels);
      }
    } catch (error) {
      toast({ title: "Print Error", description: getErrorDetails(error).message, variant: "destructive" });
    }
  };

  const handlePrintWithWorker = async () => {
    if (!printWorkerBale) return;
    setAssigningWorker(true);
    try {
      if (printWorkerIdSelected) {
        await modeApiRequest("PATCH", `/api/factory/bales/${printWorkerBale.id}/assign-worker`, {
          workerId: parseInt(printWorkerIdSelected),
        });
        queryClient.invalidateQueries({ queryKey: ["/api/factory/stock-entry/in-stock"] });
      }
      setPrintWorkerBale(null);
      setPrintWorkerIdSelected("");
      await printSingleBale(printWorkerBale);
    } catch (err) {
      toast({ title: "Error", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setAssigningWorker(false);
    }
  };

  const { data: locations } = useQuery<Location[]>({ queryKey: ["/api/locations"] });
  const activeLocations = (locations || []).filter((l) => l.active);

  const { data: inStockBales, isLoading: balesLoading } = useQuery<InStockBale[]>({
    queryKey: ["/api/factory/stock-entry/in-stock", selectedLocationId],
    queryFn: async () => {
      const locParam = selectedLocationId && selectedLocationId !== "all" ? `?locationId=${selectedLocationId}` : "";
      const url = `/api/factory/stock-entry/in-stock${locParam}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: true,
  });

  const filteredBales = inStockBales?.filter((bale) => {
    if (!dateFilter) return true;
    const baleDate = bale.finalizedAt ? new Date(bale.finalizedAt).toLocaleDateString("en-CA") : null;
    return baleDate === dateFilter;
  });

  const condensedRows = (() => {
    if (!filteredBales) return [];
    const grouped: Record<
      string,
      {
        groupKey: string;
        articleCode: string;
        productName: string;
        qty: number;
        totalWeight: number;
        baleIds: number[];
      }
    > = {};
    for (const bale of filteredBales) {
      const key = bale.articleCode || bale.productName || `unknown-${bale.id}`;
      if (!grouped[key]) {
        grouped[key] = {
          groupKey: key,
          articleCode: bale.articleCode || "-",
          productName: bale.productName || "-",
          qty: 0,
          totalWeight: 0,
          baleIds: [],
        };
      }
      grouped[key].qty += 1;
      grouped[key].totalWeight += parseFloat(bale.weightKg || "0");
      grouped[key].baleIds.push(bale.id);
    }
    return Object.values(grouped).sort((a, b) => a.productName.localeCompare(b.productName));
  })();

  const totalQty = filteredBales?.length || 0;
  const totalWeight = filteredBales?.reduce((sum: number, b) => sum + parseFloat(b.weightKg || "0"), 0) || 0;

  const toggleBale = (baleId: number) => {
    setSelectedBaleIds((prev) => {
      const next = new Set(prev);
      if (next.has(baleId)) next.delete(baleId);
      else next.add(baleId);
      return next;
    });
  };

  const toggleCondensedRow = (baleIds: number[]) => {
    setSelectedBaleIds((prev) => {
      const next = new Set(prev);
      const allSelected = baleIds.every((id) => next.has(id));
      if (allSelected) {
        baleIds.forEach((id) => next.delete(id));
      } else {
        baleIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const selectAll = () => {
    if (!filteredBales) return;
    const allIds = new Set(filteredBales.map((b) => b.id));
    setSelectedBaleIds(allIds);
  };

  const clearSelection = () => setSelectedBaleIds(new Set());

  const handleRemoveClick = () => {
    if (selectedBaleIds.size === 0) {
      toast({ title: "Error", description: "Select at least one bale to remove", variant: "destructive" });
      return;
    }
    setRemoveDialogOpen(true);
    setSupervisorUsername("");
    setSupervisorPassword("");
    setRemovalReason("");
    setAuthError("");
  };

  const removeMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", "/api/factory/bales/bulk-remove", {
        baleIds: Array.from(selectedBaleIds),
        supervisorUsername,
        supervisorPassword,
        reason: removalReason,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Removal failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Success", description: `Removed ${data.removedCount} bale(s) from stock.` });
      setSelectedBaleIds(new Set());
      setRemoveDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock-entry/in-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales/daily-summary"] });
    },
    onError: (err: Error) => {
      setAuthError(err.message);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap bg-muted/30 p-4 rounded-xl border">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="w-48">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1 ml-1">Location</p>
            <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
              <SelectTrigger className="h-9 rounded-lg" data-testid="select-remove-location">
                <SelectValue placeholder="All Locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                {activeLocations?.map((loc) => (
                  <SelectItem key={loc.id} value={loc.id.toString()}>
                    {loc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-40">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1 ml-1">
              Date Filter
            </p>
            <Input
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="h-9 rounded-lg"
              data-testid="input-remove-date"
            />
          </div>
          <div className="flex items-center gap-1 bg-background border rounded-lg p-1 h-9 self-end">
            <Button
              variant={viewMode === "condensed" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-[10px] font-bold px-2 rounded-md"
              onClick={() => setViewMode("condensed")}
            >
              <LayoutList className="h-3 w-3 mr-1" />
              CONDENSED
            </Button>
            <Button
              variant={viewMode === "detailed" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-[10px] font-bold px-2 rounded-md"
              onClick={() => setViewMode("detailed")}
            >
              <List className="h-3 w-3 mr-1" />
              DETAILED
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end">
          <Button variant="outline" size="sm" className="h-9" onClick={selectAll} data-testid="button-select-all">
            Select All
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={clearSelection}
            data-testid="button-clear-selection"
          >
            Clear
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-9 gap-2"
            disabled={selectedBaleIds.size === 0}
            onClick={handleRemoveClick}
            data-testid="button-remove-selected"
          >
            <Trash2 className="h-4 w-4" />
            Remove Selected ({selectedBaleIds.size})
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => setImportingNames(true)}
            data-testid="button-import-names"
          >
            <Upload className="h-4 w-4 mr-2" />
            Import Names
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => setReimporting(true)}
            data-testid="button-reimport-bales"
          >
            <Upload className="h-4 w-4 mr-2" />
            Re-import
          </Button>
        </div>
      </div>

      <RemoveFromStockTable
        viewMode={viewMode}
        loading={balesLoading}
        filteredBales={filteredBales}
        condensedRows={condensedRows}
        selectedBaleIds={selectedBaleIds}
        onToggleBale={toggleBale}
        onToggleCondensedRow={toggleCondensedRow}
        formatDisplayDate={formatDisplayDate}
        onPrintBale={(bale) => {
          if (bale.finalizedBy) printSingleBale(bale);
          else setPrintWorkerBale(bale);
        }}
      />

      <div className="flex items-center justify-between px-4 py-3 bg-muted/20 rounded-xl border border-dashed">
        <div className="flex items-center gap-6">
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Filtered Count</span>
            <span className="text-lg font-black tabular-nums">
              {totalQty} <span className="text-xs font-normal text-muted-foreground">bales</span>
            </span>
          </div>
          <div className="flex flex-col border-l pl-6">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
              Filtered Weight
            </span>
            <span className="text-lg font-black tabular-nums">
              {totalWeight.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">kg</span>
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
            {selectedBaleIds.size} SELECTED
          </span>
        </div>
      </div>

      <RemoveBaleAuthDialog
        open={removeDialogOpen}
        onOpenChange={setRemoveDialogOpen}
        selectedCount={selectedBaleIds.size}
        supervisorUsername={supervisorUsername}
        onSupervisorUsernameChange={setSupervisorUsername}
        supervisorPassword={supervisorPassword}
        onSupervisorPasswordChange={setSupervisorPassword}
        removalReason={removalReason}
        onRemovalReasonChange={setRemovalReason}
        authError={authError}
        isPending={removeMutation.isPending}
        onConfirm={() => removeMutation.mutate()}
      />

      <AssignWorkerDialog
        open={!!printWorkerBale}
        onOpenChange={(open) => !open && setPrintWorkerBale(null)}
        workers={workers}
        workerIdSelected={printWorkerIdSelected}
        onWorkerIdChange={setPrintWorkerIdSelected}
        isPending={assigningWorker}
        onConfirm={handlePrintWithWorker}
      />

      <input
        type="file"
        ref={namesFileRef}
        className="hidden"
        accept=".xlsx,.xls,.csv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) bulkUpdateNamesMutation.mutate(file);
          e.target.value = "";
        }}
      />
      <input
        type="file"
        ref={reimportFileRef}
        className="hidden"
        accept=".xlsx,.xls,.csv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) reimportMutation.mutate(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
