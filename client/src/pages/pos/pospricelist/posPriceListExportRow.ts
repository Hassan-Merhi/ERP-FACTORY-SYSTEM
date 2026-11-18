// Extracted from ./usePosPriceListModel.ts to keep that module under the source-size cap.
import type { PriceListRow } from "./types";

/** One worksheet row of the POS price list export (same columns and values as before the move). */
export function buildPosPriceListExportRow(
  item: PriceListRow,
  options: {
    showCostPrice: boolean;
    isAllMode: boolean;
    masters: { id: number; name: string }[];
    masterPriceFor: (item: PriceListRow, locationId: number) => string | null;
  }
): Record<string, unknown> {
  const { showCostPrice, isAllMode, masters, masterPriceFor } = options;
  const row: Record<string, unknown> = {
    Code: item.code || "",
    "Item Name": item.name,
    Group: item.stockGroupName || "",
  };

  if (showCostPrice) {
    row["Cost Price"] = item.costPrice && parseFloat(item.costPrice) > 0 ? parseFloat(item.costPrice) : "";
    const offloadTotal = parseFloat(item.costPrice ?? "0") + parseFloat(item.offloadingCost ?? "0");
    row["Cost + Offloading"] = offloadTotal > 0 ? offloadTotal : "";
  }

  if (isAllMode) {
    row["Total Qty"] = parseFloat(item.totalQuantity ?? "0");
    for (const m of masters) {
      const price = masterPriceFor(item, m.id);
      row[m.name] = price && parseFloat(price) > 0 ? parseFloat(price) : "";
    }
  } else {
    row["Highest Price Sold"] = item.highestPriceSold == null ? "" : Number(item.highestPriceSold);
    row["Lowest Price Sold"] = item.lowestPriceSold == null ? "" : Number(item.lowestPriceSold);
    row["Qty Sold"] = Number(item.qtySold ?? 0);
    row["Selling Price"] =
      item.sellingPrice && parseFloat(item.sellingPrice) > 0
        ? parseFloat(item.sellingPrice)
        : item.baseSellingPrice && parseFloat(item.baseSellingPrice) > 0
          ? parseFloat(item.baseSellingPrice)
          : "";
    row["Qty in Stock"] = item.quantity && parseFloat(item.quantity) > 0 ? parseFloat(item.quantity) : "";
  }

  return row;
}

/** Ordered worksheet headers and their cell types for the POS price list export. */
export function posPriceListExportColumns(options: {
  showCostPrice: boolean;
  isAllMode: boolean;
  masters: { id: number; name: string }[];
}): { headers: string[]; types: Record<string, "auto" | "money" | "decimal"> } {
  const { showCostPrice, isAllMode, masters } = options;
  const headers = [
    "Code",
    "Item Name",
    "Group",
    ...(showCostPrice ? ["Cost Price", "Cost + Offloading"] : []),
    ...(isAllMode
      ? ["Total Qty", ...masters.map((master) => master.name)]
      : ["Highest Price Sold", "Lowest Price Sold", "Qty Sold", "Selling Price", "Qty in Stock"]),
  ];
  const types: Record<string, "auto" | "money" | "decimal"> = {};
  for (const key of headers.slice(3)) types[key] = key.includes("Qty") ? "decimal" : "money";
  return { headers, types };
}
