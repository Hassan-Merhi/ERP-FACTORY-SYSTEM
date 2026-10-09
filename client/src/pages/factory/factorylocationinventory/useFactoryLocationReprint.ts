import { useState } from "react";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { isZebraMode, printRawZpl } from "@/lib/zebraPrint";
import { buildZplBatch } from "@/lib/zplBuilder";
import { getPaperFormat } from "@/components/LabelPrintSettings";
import {
  generateA5LabelsHtml,
  generateCombinedLabelsHtml,
  generateStickerLabelsHtml,
  prefetchBannersForPrint,
  type A4DesignColor,
  type LabelData,
} from "@/lib/labelHtml";

import type { FactoryBaleProduct, Location } from "./types";

interface ReprintBaleRow {
  bale: {
    id: number;
    referenceNumber?: string;
    baleCode?: string;
    articleCode?: string;
    category?: string;
    quantity?: number;
    weightKg?: string;
    productName?: string;
  };
  product?: {
    articleCode?: string;
    name?: string;
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

export function useFactoryLocationReprint(selectedLocation: Location | null) {
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { toast } = useToast();
  const [reprintDialogOpen, setReprintDialogOpen] = useState(false);
  const [reprintProduct, setReprintProduct] = useState<FactoryBaleProduct | null>(null);
  const [reprintBales, setReprintBales] = useState<ReprintBaleRow[]>([]);
  const [reprintLoading, setReprintLoading] = useState(false);
  const [reprintDesignPickerOpen, setReprintDesignPickerOpen] = useState(false);
  const [reprintPendingLabels, setReprintPendingLabels] = useState<LabelData[]>([]);

  const openBrowserReprintLabels = (labels: LabelData[], designColor?: A4DesignColor) => {
    prefetchBannersForPrint();
    const format = getPaperFormat();
    if (format === "A4" && !designColor && !labels.some((label) => label.priorityColor)) {
      setReprintPendingLabels(labels);
      setReprintDesignPickerOpen(true);
      return;
    }
    const paperHtml = format === "A5" ? generateA5LabelsHtml(labels) : generateCombinedLabelsHtml(labels, designColor);
    const stickerHtml = generateStickerLabelsHtml(labels);

    const paperWindow = window.open("", "_blank", "width=800,height=900");
    if (paperWindow) {
      paperWindow.document.write(paperHtml);
      paperWindow.document.close();
      paperWindow.focus();
      setTimeout(() => paperWindow.print(), 500);
    }

    const stickerWindow = window.open("", "_blank", "width=400,height=600");
    if (stickerWindow) {
      stickerWindow.document.write(stickerHtml);
      stickerWindow.document.close();
      stickerWindow.focus();
      const images = stickerWindow.document.images;
      let loaded = 0;
      const total = images.length;
      const tryPrint = () => {
        loaded++;
        if (loaded >= total) setTimeout(() => stickerWindow.print(), 300);
      };
      if (total === 0) {
        setTimeout(() => stickerWindow.print(), 300);
      } else {
        for (let index = 0; index < total; index++) {
          if (images[index].complete) tryPrint();
          else images[index].onload = images[index].onerror = tryPrint;
        }
      }
    }

    if (!paperWindow && !stickerWindow) {
      toast({ title: "Warning", description: "Please allow pop-ups to print labels", variant: "destructive" });
    }
  };

  const handleReprintProduct = async (product: FactoryBaleProduct) => {
    if (!selectedLocation) return;
    setReprintProduct(product);
    setReprintBales([]);
    setReprintLoading(true);
    setReprintDialogOpen(true);
    try {
      const response = await fetch(
        `/api/factory/bales?locationId=${selectedLocation.id}&productId=${product.productId}&status=IN_STOCK`,
        { credentials: "include" }
      );
      if (!response.ok) throw new Error("Failed to fetch bales");
      setReprintBales(await response.json());
    } catch (error: unknown) {
      toast({ title: "Error", description: errorMessage(error), variant: "destructive" });
      setReprintDialogOpen(false);
    } finally {
      setReprintLoading(false);
    }
  };

  const handleDoPrint = async () => {
    if (reprintBales.length === 0) return;
    const labels: LabelData[] = reprintBales.map((row) => ({
      referenceNumber: row.bale.referenceNumber || row.bale.baleCode || "",
      articleCode: row.product?.articleCode || row.bale.articleCode || row.bale.category || "",
      pieces: row.bale.quantity || 1,
      approxWeightKg: row.bale.weightKg || "0",
      productName: row.bale.productName || row.product?.name || row.bale.category || "",
    }));

    for (const [index, row] of reprintBales.entries()) {
      try {
        const response = await modeApiRequest("POST", "/api/bale-label-prints/reprint", { baleId: row.bale.id });
        if (!response.ok) throw new Error("Could not prepare reprint");
        const result = (await response.json()) as {
          priorityAllocation?: { color: string; orderId: number; priority: number } | null;
        };
        if (result.priorityAllocation) {
          labels[index].priorityColor = result.priorityAllocation.color;
          labels[index].priorityOrderId = result.priorityAllocation.orderId;
          labels[index].priorityNumber = result.priorityAllocation.priority;
        }
      } catch (error) {
        toast({ title: "Reprint preparation failed", description: errorMessage(error), variant: "destructive" });
        return;
      }
    }

    setReprintDialogOpen(false);
    if (isZebraMode() && !labels.some((label) => label.priorityColor)) {
      try {
        await printRawZpl(buildZplBatch(labels, true));
        toast({ title: `${labels.length} label(s) sent to Zebra printer` });
      } catch (error: unknown) {
        toast({
          title: "Zebra print failed — falling back to browser",
          description: errorMessage(error),
          variant: "destructive",
        });
        openBrowserReprintLabels(labels);
      }
    } else {
      openBrowserReprintLabels(labels);
    }
  };

  return {
    reprintDialogOpen,
    setReprintDialogOpen,
    reprintProduct,
    setReprintProduct,
    reprintBales,
    setReprintBales,
    reprintLoading,
    reprintDesignPickerOpen,
    setReprintDesignPickerOpen,
    reprintPendingLabels,
    openBrowserReprintLabels,
    handleReprintProduct,
    handleDoPrint,
  };
}
