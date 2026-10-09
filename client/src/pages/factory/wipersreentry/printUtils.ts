import {
  generateA5LabelsHtml,
  generateCombinedLabelsHtml,
  generateStickerLabelsHtml,
  prefetchBannersForPrint,
  type A4DesignColor,
  type LabelData,
} from "@/lib/labelHtml";
import type { CreatedBale } from "./types";

export type WipersPrintFormat = "A4" | "A5" | "sticker";

export function buildLabelData(bales: CreatedBale[]): LabelData[] {
  return bales.map((bale) => ({
    referenceNumber: bale.referenceNumber,
    articleCode: bale.articleCode || "",
    pieces: 1,
    approxWeightKg: bale.weightKg || "0",
    productName: bale.productName || "",
  }));
}

/** Returns false only when A4 still needs a design-color choice. */
export function printLabelsInBrowser(
  labels: LabelData[],
  format: WipersPrintFormat,
  designColor?: A4DesignColor
): boolean {
  prefetchBannersForPrint();
  if (format === "A4" && !designColor && !labels.some((label) => label.priorityColor)) return false;

  const popup = window.open("", "_blank");
  if (!popup) return true;
  const html =
    format === "sticker"
      ? generateStickerLabelsHtml(labels)
      : format === "A5"
        ? generateA5LabelsHtml(labels)
        : generateCombinedLabelsHtml(labels, designColor!);
  popup.document.write(html);
  popup.document.close();
  popup.focus();
  setTimeout(() => popup.print(), 500);
  return true;
}
