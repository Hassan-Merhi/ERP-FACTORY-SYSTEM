// Extracted from ./FactoryReprintLabels.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { assertReprintMatchesPrepared, preparePriorityPrintLabels } from "@/lib/priorityPrintPreflight";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { isZebraMode, printRawZpl } from "@/lib/zebraPrint";
import { buildZplBatch } from "@/lib/zplBuilder";
import { getPaperFormat } from "@/components/LabelPrintSettings";
import {
  type A4DesignColor,
  generateA5LabelsHtml,
  generateCombinedLabelsHtml,
  generateStickerLabelsHtml,
  type LabelData,
  prefetchBannersForPrint,
} from "@/lib/labelHtml";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
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

export function useFactoryReprintLabelsState() {
  const { toast } = useToast();
  const { colors } = useLabelDesignColors();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  // Each reprint is recorded against the bale, so read-only roles cannot reprint.
  const recordChanges = useExistingRecordChangeAccess();

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
  const {
    data: balesData = [],
    isLoading: balesLoading,
    isError: balesError,
    refetch: refetchBales,
  } = useQuery<BaleRow[]>({
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
    if (!recordChanges.allowed) return;
    const rowsToPrint = filteredBales.filter((r) => selectedIds.has(r.bale.id));
    if (rowsToPrint.length === 0) {
      toast({ title: "Nothing selected", description: "Tick at least one bale to print.", variant: "destructive" });
      return;
    }

    let labels: LabelData[] = rowsToPrint.map((row) => ({
      referenceNumber: row.bale.referenceNumber || row.bale.baleCode,
      articleCode: row.product?.articleCode || row.bale.articleCode || row.bale.category || "",
      pieces: row.bale.quantity || 1,
      approxWeightKg: row.bale.weightKg || "0",
      productName: row.bale.productName || row.product?.name || row.bale.category || "",
    }));

    try {
      labels = await preparePriorityPrintLabels(
        labels,
        modeApiRequest,
        rowsToPrint.map((row) => row.bale.id)
      );
      // Keep existing per-bale reprint audit records. They repeat the same
      // server assignment lookup idempotently and must agree with the labels.
      for (const [index, row] of rowsToPrint.entries()) {
        const response = await modeApiRequest("POST", "/api/bale-label-prints/reprint", { baleId: row.bale.id });
        await assertReprintMatchesPrepared(response, labels[index]);
      }
    } catch (error) {
      toast({
        title: "Reprint preparation failed",
        description: getErrorDetails(error).message,
        variant: "destructive",
      });
      return;
    }

    if (isZebraMode() && !labels.some((label) => label.priorityColor)) {
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
  return {
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
  };
}
