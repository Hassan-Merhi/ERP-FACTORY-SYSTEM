import { Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WorkerOption } from "./types";

export interface StockEntryProductionPosition {
  id: number;
  name: string;
  active: boolean;
  workerIds: number[];
}

interface StockEntryProductionItem {
  productId: number;
  product: { name?: string };
  finalizedBy: number | null;
}

export function eligibleProductionPositions(
  positions: StockEntryProductionPosition[],
  workerId: number | null
): StockEntryProductionPosition[] {
  if (!workerId) return [];
  // workerIds already reflects the server's effective-dated membership for the
  // Stock Entry date. Do not filter on the position's current active flag: an
  // archived position can still be historically valid for a backdated entry.
  return positions.filter((position) => Array.isArray(position.workerIds) && position.workerIds.includes(workerId));
}

export function StockEntryProductionPositions({
  cart,
  workers,
  positions,
  selectedByProduct,
  onSelect,
}: {
  cart: StockEntryProductionItem[];
  workers: WorkerOption[];
  positions: StockEntryProductionPosition[];
  selectedByProduct: Record<number, number | null>;
  onSelect: (productId: number, positionId: number | null) => void;
}) {
  const assignedItems = cart.filter((item) => !!item.finalizedBy);
  if (assignedItems.length === 0) return null;

  const workerName = (workerId: number | null) => {
    const worker = workers.find((candidate) => candidate.id === workerId);
    return worker?.fullName || worker?.name || `Worker #${workerId}`;
  };

  return (
    <div className="rounded-xl border bg-card/50 p-3" data-testid="stock-entry-production-positions">
      <div className="mb-3 flex items-start gap-2">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <Target className="h-3.5 w-3.5" />
        </div>
        <div>
          <div className="text-sm font-bold">Production Position</div>
          <div className="text-xs text-muted-foreground">
            Single-position workers are assigned automatically. Choose the position only when a worker belongs to more
            than one.
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {assignedItems.map((item) => {
          const eligible = eligibleProductionPositions(positions, item.finalizedBy);
          const selectedId = selectedByProduct[item.productId] ?? null;
          const selected = eligible.find((position) => position.id === selectedId) ?? null;

          return (
            <div
              key={item.productId}
              className="grid gap-2 rounded-lg border bg-background/60 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(12rem,1fr)] sm:items-center"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold">
                  {item.product?.name || `Product #${item.productId}`}
                </div>
                <div className="text-[10px] text-muted-foreground">{workerName(item.finalizedBy)}</div>
              </div>

              <div className="text-xs text-muted-foreground">
                {eligible.length === 0 ? (
                  <Badge variant="outline" className="whitespace-normal text-[10px]">
                    No production position — bonus ineligible
                  </Badge>
                ) : eligible.length === 1 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" className="text-[10px]">
                      {eligible[0].name}
                    </Badge>
                    <span className="text-[10px]">Auto</span>
                  </div>
                ) : (
                  <span className="text-[10px]">{eligible.length} positions available</span>
                )}
              </div>

              {eligible.length > 1 ? (
                <Select
                  value={selected ? String(selected.id) : undefined}
                  onValueChange={(value) => onSelect(item.productId, Number(value))}
                >
                  <SelectTrigger
                    className={!selected ? "border-amber-500/70" : ""}
                    data-testid={`select-production-position-${item.productId}`}
                  >
                    <SelectValue placeholder="Choose production position..." />
                  </SelectTrigger>
                  <SelectContent>
                    {eligible.map((position) => (
                      <SelectItem key={position.id} value={String(position.id)}>
                        {position.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : eligible.length === 1 ? (
                <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{eligible[0].name}</div>
              ) : (
                <div className="text-xs text-muted-foreground">No bonus attribution</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
