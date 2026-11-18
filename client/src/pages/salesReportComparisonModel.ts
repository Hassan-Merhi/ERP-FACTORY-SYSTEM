// Extracted from ./SalesReportComparison.tsx to keep that module under the source-size cap.
export interface SalesItem {
  stockItemId: number;
  stockItemCode: string;
  stockItemName: string;
  stockGroupName: string | null;
  quantity: string;
  totalSales: string;
  costProfit: string;
  configuredProfit: number;
  configuredProfitPercentage: number;
  costProfitPercentage: number;
  totalConfiguredCost: number;
  companyId: number;
  companyCode: string;
  companyName: string;
}

export interface ItemRow {
  stockItemCode: string;
  stockItemName: string;
  stockGroupName: string;
  byCompany: Record<
    string,
    {
      totalSales: number;
      totalQty: number;
      costProfit: number;
    }
  >;
}

export type ViewFilter = "all" | "gaining" | "losing";

export interface Company {
  code: string;
  name: string;
}

export function getAiResult(row: ItemRow, companies: Company[]): string {
  if (companies.length < 2) return "—";

  const data = companies.map((c) => ({
    code: c.code,
    name: c.name.toUpperCase(),
    qty: row.byCompany[c.code]?.totalQty ?? 0,
    profit: row.byCompany[c.code]?.costProfit ?? 0,
  }));

  const hasAnyData = data.some((d) => d.qty > 0 || d.profit !== 0);
  if (!hasAnyData) return "—";

  const maxQty = Math.max(...data.map((d) => d.qty));
  const maxProfit = Math.max(...data.map((d) => d.profit));

  const qtyWinners = data.filter((d) => d.qty === maxQty);
  const profitWinners = data.filter((d) => d.profit === maxProfit);

  const qtyTied = qtyWinners.length > 1;
  const profitTied = profitWinners.length > 1;

  if (qtyTied && profitTied) return "EQUAL IN BOTH";

  const sameWinner = !qtyTied && !profitTied && qtyWinners[0].code === profitWinners[0].code;

  if (sameWinner) {
    return `${qtyWinners[0].name} BETTER IN SALES & PROFIT`;
  }

  const salesPart = qtyTied ? "SALES EQUAL" : `${qtyWinners[0].name} BETTER IN SALES`;
  const profitPart = profitTied ? "PROFIT EQUAL" : `${profitWinners[0].name} BETTER IN PROFIT`;

  if (qtyTied) return profitPart;
  if (profitTied) return salesPart;
  return `${profitPart} — ${salesPart}`;
}
