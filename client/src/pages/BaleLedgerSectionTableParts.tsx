// Extracted from ./BaleLedgerSectionTable.tsx
import { useQuery } from "@tanstack/react-query";
import { TableCell, TableRow } from "@/components/ui/table";
import { formatUsd } from "@/lib/moneyDisplay";

interface BaleDetail {
  ref: string;
  weightKg: number;
  totalCost: number;
}

export interface BucketRow {
  productId: number | null;
  productName: string;
  articleCode: string;
  categoryName: string;
  baleCount: number;
  totalWeightKg: number;
  totalCost: number;
}

export interface SectionTotal {
  baleCount: number;
  totalWeightKg: number;
  totalCost: number;
}

export function fmtMoney(n: number): string {
  if (n === 0) return "$0";
  const rounded = Math.round(n * 100) / 100;
  if (rounded % 1 === 0) {
    return formatUsd(rounded, 0);
  }
  return formatUsd(rounded, 2);
}

export function fmtKg(n: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(n);
}

export type SectionKey = "currentStock" | "wasteStock" | "sold" | "wasteDispatched" | "pendingLoading";

export interface SectionProps {
  section: SectionKey;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  badgeColor: string;
  rows: BucketRow[];
  total: SectionTotal;
  defaultOpen?: boolean;
  showSoldPrice?: boolean;
}

export function BaleDetailRows({
  section,
  productId,
  rowAvgRate,
  totalWeightKg,
  totalCost,
  baleCount,
  colSpan,
}: {
  section: SectionKey;
  productId: number | null;
  rowAvgRate: number;
  totalWeightKg: number;
  totalCost: number;
  baleCount: number;
  colSpan: number;
}) {
  const { data, isLoading } = useQuery<{ baleDetails: BaleDetail[] }>({
    queryKey: ["/api/factory/bale-ledger/details", section, productId ?? "null"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/bale-ledger/details?section=${section}&productId=${productId ?? "null"}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch bale details");
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  if (isLoading) {
    return (
      <TableRow className="bg-muted/20">
        <TableCell colSpan={colSpan} className="py-2 px-5 text-xs text-muted-foreground italic">
          Loading bale details…
        </TableCell>
      </TableRow>
    );
  }

  const baleDetails = data?.baleDetails || [];
  const hasBaleDetails = baleDetails.some((d) => d.ref || d.totalCost > 0);

  if (!hasBaleDetails) {
    return (
      <TableRow className="bg-muted/20">
        <TableCell colSpan={colSpan} className="py-2 px-5 text-xs text-muted-foreground italic">
          No individual bale records found.
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow className="bg-muted/20">
      <TableCell colSpan={colSpan} className="py-0 px-0">
        <div className="pl-8 pr-3 py-2">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-30 bg-muted">
              <tr className="border-b border-border/50">
                <th className="text-left py-1 pr-4 font-medium text-muted-foreground">Ref #</th>
                <th className="text-right py-1 pr-4 font-medium text-muted-foreground">Weight (kg)</th>
                <th className="text-right py-1 pr-4 font-medium text-muted-foreground">Qty</th>
                <th className="text-right py-1 pr-4 font-medium text-muted-foreground">Avg Cost/Bale</th>
                <th className="text-right py-1 font-medium text-muted-foreground">Total Cost</th>
              </tr>
            </thead>
            <tbody>
              {baleDetails.map((d, di) => (
                <tr key={di} className="border-b border-border/20 last:border-0">
                  <td className="py-1 pr-4 font-mono">{d.ref || "—"}</td>
                  <td className="py-1 pr-4 text-right text-muted-foreground">{fmtKg(d.weightKg)}</td>
                  <td className="py-1 pr-4 text-right text-muted-foreground">1</td>
                  <td className="py-1 pr-4 text-right text-muted-foreground">
                    {d.totalCost > 0 ? fmtMoney(d.totalCost) : "—"}
                  </td>
                  <td className="py-1 text-right font-medium">{d.totalCost > 0 ? fmtMoney(d.totalCost) : "—"}</td>
                </tr>
              ))}
              {baleDetails.length > 1 && (
                <tr className="font-semibold border-t border-border/50">
                  <td className="py-1 pr-4 text-muted-foreground">Total</td>
                  <td className="py-1 pr-4 text-right">{fmtKg(totalWeightKg)}</td>
                  <td className="py-1 pr-4 text-right">{baleCount}</td>
                  <td className="py-1 pr-4 text-right">{rowAvgRate > 0 ? fmtMoney(rowAvgRate) : "—"}</td>
                  <td className="py-1 text-right">{totalCost > 0 ? fmtMoney(totalCost) : "—"}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </TableCell>
    </TableRow>
  );
}
