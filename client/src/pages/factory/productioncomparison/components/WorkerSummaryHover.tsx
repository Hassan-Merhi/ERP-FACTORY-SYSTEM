import { useState } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

import type { ProductRow } from "../types";
import { fmtNum } from "../utils";

export interface WorkerSummary {
  name: string;
  aQty: number;
  bQty: number;
  total: number;
}

export function buildWorkerSummaryByArticle(periodA: ProductRow[], periodB: ProductRow[]) {
  const byArticle = new Map<string, Map<string, { name: string; aQty: number; bQty: number }>>();

  const tally = (row: ProductRow, period: "a" | "b") => {
    let workersForProduct = byArticle.get(row.articleCode);
    if (!workersForProduct) {
      workersForProduct = new Map();
      byArticle.set(row.articleCode, workersForProduct);
    }

    for (const worker of row.workers ?? []) {
      const name = (worker?.name || "").trim();
      if (!name) continue;
      const key = worker.id != null ? `id:${worker.id}` : `name:${name.toLowerCase()}`;
      const existing = workersForProduct.get(key) ?? { name, aQty: 0, bQty: 0 };
      if (period === "a") existing.aQty += worker.qty ?? 0;
      else existing.bQty += worker.qty ?? 0;
      workersForProduct.set(key, existing);
    }
  };

  for (const row of periodA) tally(row, "a");
  for (const row of periodB) tally(row, "b");

  const result = new Map<string, WorkerSummary[]>();
  for (const [articleCode, workersForProduct] of byArticle) {
    result.set(
      articleCode,
      [...workersForProduct.values()]
        .map((worker) => ({ ...worker, total: worker.aQty + worker.bQty }))
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    );
  }
  return result;
}

export function WorkerSummaryHover({
  workers,
  labelA,
  labelB,
}: {
  workers: WorkerSummary[];
  labelA: string;
  labelB: string;
}) {
  // Hover opens it on desktop; a tap toggles it so touch screens (which never hover) can read it too.
  const [open, setOpen] = useState(false);
  if (workers.length === 0) return <span className="text-muted-foreground text-xs">—</span>;

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="inline-flex items-center rounded-md border border-border bg-background px-2 py-1 text-xs font-medium whitespace-nowrap hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${workers.length} worker${workers.length === 1 ? "" : "s"}. Show bale details.`}
        >
          {workers.length} worker{workers.length === 1 ? "" : "s"}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-sm font-semibold">
            {workers.length} worker{workers.length === 1 ? "" : "s"}
          </p>
          <span className="text-xs text-muted-foreground">Bales by worker</span>
        </div>
        <div className="space-y-2">
          {workers.map((worker) => (
            <div key={worker.name} className="rounded-md border bg-muted/20 px-2.5 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium" dir="auto">
                  {worker.name}
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {fmtNum(worker.total)} bale{worker.total === 1 ? "" : "s"}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  {labelA}: {fmtNum(worker.aQty)}
                </span>
                <span>
                  {labelB}: {fmtNum(worker.bQty)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
