import * as XLSX from "@/lib/excelHelper";
import type { OrderBale } from "./types";

export interface BaleGroup {
  articleCode: string;
  baleName: string;
  bales: OrderBale[];
  totalWeight: number;
}

/**
 * Groups a loading order's bales by article code (most recently scanned group
 * first) and totals their weight and per-article counts.
 */
export function summarizeLoadedBales(bales: OrderBale[]) {
  const groupedBalesMap = bales.reduce<Record<string, BaleGroup>>((acc, bale) => {
    const key = bale.articleCode ?? "__unknown__";
    if (!acc[key]) {
      acc[key] = {
        articleCode: bale.articleCode ?? "",
        baleName: bale.baleName,
        bales: [],
        totalWeight: 0,
      };
    }
    acc[key].bales.push(bale);
    acc[key].totalWeight += parseFloat(bale.weight || "0");
    return acc;
  }, {});

  const orderedGroups = Object.values(groupedBalesMap).sort((a, b) => {
    const maxA = Math.max(...a.bales.map((x) => x.id));
    const maxB = Math.max(...b.bales.map((x) => x.id));
    return maxB - maxA;
  });

  const totalWeight = bales.reduce((sum, b) => sum + parseFloat(b.weight || "0"), 0);

  const loadedByArticle = bales.reduce<Record<string, number>>((map, b) => {
    const key = b.articleCode ?? "__unknown__";
    map[key] = (map[key] || 0) + 1;
    return map;
  }, {});

  return { groupedBalesMap, orderedGroups, totalWeight, loadedByArticle };
}

/** Downloads the bulk-import template for scanning by ref number or by article code. */
export async function downloadBaleImportTemplate(mode: "ref" | "articleCode"): Promise<void> {
  const wb = XLSX.utils.book_new();
  let ws;
  if (mode === "ref") {
    ws = XLSX.utils.aoa_to_sheet([["Ref Number"], ["REF00001"], ["REF00002"], ["REF00003"]]);
    ws["!cols"] = [{ wch: 20 }];
  } else {
    ws = XLSX.utils.aoa_to_sheet([
      ["Article Code", "Qty"],
      ["ART001", 10],
      ["ART002", 5],
    ]);
    ws["!cols"] = [{ wch: 20 }, { wch: 10 }];
  }
  XLSX.utils.book_append_sheet(wb, ws, "Import");
  await XLSX.writeFile(
    wb,
    mode === "ref" ? "bale-import-ref-number-template.xlsx" : "bale-import-article-code-template.xlsx"
  );
}
