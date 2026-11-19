// Extracted from ./RetailDashboard.tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { quantity, type DashboardRow } from "./RetailDashboardRankingTable";

export interface Location {
  id: number;
  name: string;
  active?: boolean;
}

export function StockTable({
  title,
  rows,
  mode,
}: {
  title: string;
  rows: DashboardRow[];
  mode: "low" | "out" | "slow";
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="border-y bg-muted/30 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2">Product</th>
              <th className="px-3 py-2">Color</th>
              <th className="px-3 py-2">Size</th>
              {mode === "low" ? <th className="px-3 py-2">Location</th> : null}
              <th className="px-3 py-2 text-right">Qty</th>
              {mode === "low" ? <th className="px-4 py-2 text-right">Low at</th> : null}
              {mode === "slow" ? <th className="px-4 py-2">Last sale</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row, index) => (
                <tr key={`${row.variant_id ?? index}-${row.location_id ?? "all"}`} className="border-b last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{row.name ?? row.product_name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{row.code ?? row.product_code ?? row.barcode}</div>
                  </td>
                  <td className="px-3 py-2.5">{row.color ?? "—"}</td>
                  <td className="px-3 py-2.5">{row.size ?? "—"}</td>
                  {mode === "low" ? <td className="px-3 py-2.5">{row.location_name ?? "—"}</td> : null}
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums">{quantity(row.quantity)}</td>
                  {mode === "low" ? (
                    <td className="px-4 py-2.5 text-right tabular-nums">{quantity(row.threshold)}</td>
                  ) : null}
                  {mode === "slow" ? (
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {row.last_sale_at ? new Date(row.last_sale_at).toLocaleDateString() : "Never"}
                    </td>
                  ) : null}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={mode === "low" ? 6 : mode === "slow" ? 5 : 4}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  Nothing to review.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
