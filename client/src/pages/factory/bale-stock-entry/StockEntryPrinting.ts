import { getErrorDetails } from "@shared/errorUtils";
import {
  type LabelData,
  type A4DesignColor,
  generateA5LabelsHtml,
  generateCombinedLabelsHtml,
  generateStickerLabelsHtml,
  prefetchBannersForPrint,
} from "@/lib/labelHtml";
import { getPaperFormat } from "@/components/LabelPrintSettings";
import { isZebraMode, printRawZpl } from "@/lib/zebraPrint";
import { buildZplBatch } from "@/lib/zplBuilder";
import type { FactoryBaleProduct } from "@shared/schema";
import type { useToast } from "@/hooks/use-toast";

interface PrintBale {
  id: number;
  productId: number;
  referenceNumber: string;
  articleCode?: string | null;
  productName?: string | null;
  weightKg: string;
}

interface PrintCartItem {
  productId: number;
  product: Pick<FactoryBaleProduct, "articleCode" | "code">;
  overrideLogoId: number | null;
}

type RequestDelegate = (method: string, url: string, data?: unknown) => Promise<Response>;
type ToastFn = ReturnType<typeof useToast>["toast"];

export const openBrowserPrint = (
  labels: LabelData[],
  designColor: A4DesignColor | undefined,
  preOpenedWindowsRef: React.MutableRefObject<{ a4: Window | null; sticker: Window | null } | null>
) => {
  // Kick off banner prefetch now (user has clicked Print) so high-res images
  // are ready by the time the print window tries to render them.
  prefetchBannersForPrint();
  const paperFormat = getPaperFormat();
  const hasPerLabelColors = labels.some((l) => l.designColor);
  const hasPerLabelLogos = labels.some((l) => l.customerLogoUrl);
  const labelsForA4 = designColor ? labels : labels.filter((l) => l.designColor || l.customerLogoUrl);

  const preOpened = preOpenedWindowsRef.current;
  preOpenedWindowsRef.current = null;

  if (paperFormat === "A4" && !designColor && !hasPerLabelColors && !hasPerLabelLogos) {
    if (preOpened?.a4 && !preOpened.a4.closed) preOpened.a4.close();
  } else if (labelsForA4.length > 0) {
    const labelHtml =
      paperFormat === "A5" ? generateA5LabelsHtml(labelsForA4) : generateCombinedLabelsHtml(labelsForA4, designColor);
    const a4Window = preOpened?.a4 && !preOpened.a4.closed ? preOpened.a4 : window.open("", "_blank");
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
  } else {
    if (preOpened?.a4 && !preOpened.a4.closed) preOpened.a4.close();
  }

  const stickerWindow = preOpened?.sticker && !preOpened.sticker.closed ? preOpened.sticker : window.open("", "_blank");
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

export const printLabels = async (
  bales: PrintBale[],
  cart: PrintCartItem[],
  baleProducts: FactoryBaleProduct[] | undefined,
  selectedLogoId: number | null,
  modeApiRequest: RequestDelegate,
  toast: ToastFn,
  preOpenedWindowsRef: React.MutableRefObject<{ a4: Window | null; sticker: Window | null } | null>
) => {
  try {
    modeApiRequest("POST", "/api/bale-label-prints", {
      bales: bales.map((bale) => {
        const cartItem = cart.find((c) => c.productId === bale.productId);
        return {
          productionBaleId: bale.id,
          productId: bale.productId,
          articleCode: bale.articleCode || cartItem?.product.articleCode || cartItem?.product.code || "",
          pieces: 1,
          approxWeightKg: bale.weightKg || "0",
        };
      }),
    }).catch(() => {});

    const labels: LabelData[] = bales.map((bale) => {
      const product = baleProducts?.find((p) => p.id === bale.productId);
      const cartItem = cart.find((c) => c.productId === bale.productId);
      const hasLogo = cartItem?.overrideLogoId || selectedLogoId;
      const effectiveColor: A4DesignColor | null = hasLogo
        ? null
        : (product?.labelDesignColor as A4DesignColor | null | undefined) || null;
      return {
        referenceNumber: bale.referenceNumber,
        articleCode: bale.articleCode || cartItem?.product.articleCode || cartItem?.product.code || "",
        pieces: 1,
        approxWeightKg: bale.weightKg || "0",
        productName: bale.productName || "",
        ...(effectiveColor ? { designColor: effectiveColor } : {}),
      };
    });

    if (isZebraMode()) {
      try {
        await printRawZpl(buildZplBatch(labels, true));
        toast({ title: "Labels sent to Zebra printer" });
        if (preOpenedWindowsRef.current) {
          if (preOpenedWindowsRef.current.a4) preOpenedWindowsRef.current.a4.close();
          if (preOpenedWindowsRef.current.sticker) preOpenedWindowsRef.current.sticker.close();
          preOpenedWindowsRef.current = null;
        }
      } catch (_err) {
        openBrowserPrint(labels, undefined, preOpenedWindowsRef);
      }
    } else {
      openBrowserPrint(labels, undefined, preOpenedWindowsRef);
    }
  } catch (error) {
    toast({ title: "Print Error", description: getErrorDetails(error).message, variant: "destructive" });
  }
};
