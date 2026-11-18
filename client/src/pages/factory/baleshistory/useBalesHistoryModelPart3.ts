// Extracted from ./useBalesHistoryModel.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { useMemo } from "react";
import type { BaleRow } from "./useBalesHistoryModelTypes";
import { useBalesHistoryModelPart1 } from "./useBalesHistoryModelPart1";

export function useBalesHistoryModelPart3({
  balesData,
  batchFilter,
  dateFilter,
  searchTerm,
  setExpandedGroups,
  statusFilter,
}: Pick<
  Awaited<ReturnType<typeof useBalesHistoryModelPart1>>,
  "balesData" | "batchFilter" | "dateFilter" | "searchTerm" | "setExpandedGroups" | "statusFilter"
>) {
  const filtered = (balesData || []).filter((row) => {
    const bale = row.bale;
    const product = row.product;
    const batch = row.mixBatch;

    // Always hide deleted bales
    if (bale.status === "REMOVED" || bale.status === "DELETED") return false;

    if (batchFilter !== "all" && String(bale.mixBatchId) !== batchFilter) return false;
    if (statusFilter !== "all" && bale.status !== statusFilter) return false;

    // When the user is actively searching by text, skip the date filter so
    // bales from any date are included (e.g. searching an old reference number).
    if (dateFilter && !searchTerm) {
      // Prefer stockEntryDate (set on all stock-entry/waste-dispatch bales) so
      // backdated entries appear on the correct day. Fall back to createdAt for
      // pressing-batch bales that don't carry a stockEntryDate.
      const baleDate = bale.stockEntryDate
        ? bale.stockEntryDate
        : bale.createdAt
          ? new Date(bale.createdAt).toLocaleDateString("en-CA")
          : null;
      if (baleDate !== dateFilter) return false;
    }

    if (
      searchTerm &&
      !searchAny(
        searchTerm,
        bale.baleCode,
        bale.referenceNumber,
        bale.barcodeValue,
        bale.category,
        product?.name,
        product?.articleCode,
        batch?.name
      )
    ) {
      return false;
    }

    return true;
  });

  const totalWeight = filtered.reduce((sum: number, row) => sum + parseFloat(row.bale.weightKg || "0"), 0);
  const totalBales = filtered.reduce((sum: number, row) => sum + (row.bale.quantity || 1), 0);

  const groupedFiltered = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        productName: string;
        articleCode: string;
        sellingPrice: string | null;
        totalQty: number;
        totalWeightKg: number;
        rows: BaleRow[];
      }
    >();
    for (const row of filtered) {
      const { bale, product } = row;
      const name = product?.name || bale.productName || bale.category || "-";
      const article = product?.articleCode || bale.category || "-";
      const key = `${name}|||${article}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          productName: name,
          articleCode: article,
          sellingPrice: product?.sellingPrice ?? null,
          totalQty: 0,
          totalWeightKg: 0,
          rows: [],
        });
      }
      const g = map.get(key)!;
      g.rows.push(row);
      g.totalQty += bale.quantity || 1;
      g.totalWeightKg += parseFloat(bale.weightKg || "0");
    }
    return Array.from(map.values());
  }, [filtered]);

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const todayStr = new Date().toLocaleDateString("en-CA");
  const summaryDate = dateFilter || todayStr;
  const todayInStock = (balesData || []).filter((row) => {
    const bale = row.bale;
    if (bale.status !== "IN_STOCK") return false;
    const baleDate = bale.stockEntryDate
      ? bale.stockEntryDate
      : bale.createdAt
        ? new Date(bale.createdAt).toLocaleDateString("en-CA")
        : null;
    return baleDate === summaryDate;
  });

  // Robust classification: check category → productName → product.name with includes() matching
  // so "Garbage Bales", "GARBAGE", " garbage " and "wiper"/"WIPERS" all classify correctly
  const getBaleClassification = (row: BaleRow): "garbage" | "wipers" | "regular" => {
    const candidates = [row.bale?.category, row.bale?.productName, row.product?.name]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((v) => v.toLowerCase().trim());

    for (const c of candidates) {
      if (c.includes("garbage")) return "garbage";
      if (c.includes("wiper")) return "wipers";
    }
    return "regular";
  };

  const todayGarbage = todayInStock.filter((row) => getBaleClassification(row) === "garbage");
  const todayWipers = todayInStock.filter((row) => getBaleClassification(row) === "wipers");
  const todayRegular = todayInStock.filter((row) => getBaleClassification(row) === "regular");
  const regularQty = todayRegular.reduce((sum: number, row) => sum + (row.bale.quantity || 1), 0);
  const regularKg = todayRegular.reduce((sum: number, row) => sum + parseFloat(row.bale.weightKg || "0"), 0);
  const garbageQty = todayGarbage.reduce((sum: number, row) => sum + (row.bale.quantity || 1), 0);
  const garbageKg = todayGarbage.reduce((sum: number, row) => sum + parseFloat(row.bale.weightKg || "0"), 0);
  const wipersQty = todayWipers.reduce((sum: number, row) => sum + (row.bale.quantity || 1), 0);
  const wipersKg = todayWipers.reduce((sum: number, row) => sum + parseFloat(row.bale.weightKg || "0"), 0);
  return {
    filtered,
    garbageKg,
    garbageQty,
    groupedFiltered,
    regularKg,
    regularQty,
    summaryDate,
    todayStr,
    toggleGroup,
    totalBales,
    totalWeight,
    wipersKg,
    wipersQty,
  };
}
