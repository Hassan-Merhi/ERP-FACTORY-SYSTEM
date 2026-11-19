// Extracted from ./FactoryNetPosition.tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmt } from "./factorynetposition/utils";
import { useFactoryNetPositionState } from "./FactoryNetPositionSection";

export function FactoryNetPositionCard({ data }: Pick<ReturnType<typeof useFactoryNetPositionState>, "data">) {
  return (
    <Card data-testid="card-broker-breakdown">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Broker Balance Breakdown</CardTitle>
        <p className="text-xs text-muted-foreground">Step-by-step calculation for each broker supplier</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {(data?.onUs.accounts ?? [])
          .filter((a) => a.code === "SUPPLIER" && a.breakdown?.length)
          .map((broker, bi) => (
            <div key={bi} className="border border-border rounded-md overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 bg-muted/30">
                <span className="font-semibold text-sm">{broker.name}</span>
                <span className="font-mono text-sm font-bold text-red-600 dark:text-red-400">{fmt(broker.value)}</span>
              </div>
              <div className="px-4 py-3 space-y-1.5">
                {broker.breakdown!.map((line, j) => {
                  const isNeg = line.usd < 0;
                  const isFxOnly = line.usd === 0;
                  const isTotal = line.label.includes("Net Balance") || line.label.includes("× ");
                  return (
                    <div
                      key={j}
                      className={`flex items-center justify-between text-xs gap-4 ${isTotal ? "border-t border-border pt-1.5 mt-1" : ""}`}
                    >
                      <div className="min-w-0">
                        <span className={isTotal ? "font-medium" : "text-foreground/80"}>{line.label}</span>
                        <span className="ml-2 font-mono text-muted-foreground">({line.native})</span>
                      </div>
                      <span
                        className={`font-mono shrink-0 font-medium ${isNeg ? "text-destructive" : isFxOnly ? "text-muted-foreground" : "text-foreground"}`}
                      >
                        {line.usd !== 0 ? fmt(line.usd) : "—"}
                      </span>
                    </div>
                  );
                })}
                <div className="border-t-2 border-border pt-2 mt-1 flex justify-between text-sm font-bold">
                  <span>Total Owed</span>
                  <span className="font-mono text-red-600 dark:text-red-400">{fmt(broker.value)}</span>
                </div>
              </div>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
