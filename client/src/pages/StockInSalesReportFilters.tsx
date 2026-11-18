// Extracted from ./StockInSalesReport.tsx to keep that module under the source-size cap.
import type { LucideIcon } from "lucide-react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function MultiSelectFilter<T extends { id: number; name: string }>({
  label,
  singularLabel,
  items,
  selectedIds,
  onChange,
  testId,
}: {
  label: string;
  singularLabel: string;
  items: T[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  testId: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" data-testid={testId}>
          {selectedIds.length === 0
            ? `All ${label}`
            : `${selectedIds.length} ${singularLabel}${selectedIds.length === 1 ? "" : "s"}`}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="start">
        <div className="max-h-72 space-y-1 overflow-y-auto">
          <div
            className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover-elevate"
            onClick={() => onChange([])}
            data-testid={`${testId}-all`}
          >
            <Checkbox checked={selectedIds.length === 0} className="pointer-events-none h-4 w-4" />
            <span className="text-sm font-medium">All {label}</span>
          </div>
          <div className="my-1 border-t" />
          {items.map((item) => {
            const id = String(item.id);
            const selected = selectedIds.includes(id);
            return (
              <div
                key={item.id}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover-elevate"
                onClick={() => onChange(selected ? selectedIds.filter((value) => value !== id) : [...selectedIds, id])}
                data-testid={`${testId}-option-${item.id}`}
              >
                <Checkbox checked={selected} className="pointer-events-none h-4 w-4" />
                <span className="text-sm">{item.name}</span>
              </div>
            );
          })}
          {items.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No options available</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function SummaryPill({
  label,
  value,
  icon: Icon,
  tone = "default",
  testId,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone?: "default" | "positive" | "negative";
  testId: string;
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "negative"
        ? "text-red-600 dark:text-red-400"
        : "text-foreground";

  return (
    <div className="flex min-h-10 items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <Icon className={`h-4 w-4 ${tone === "default" ? "text-muted-foreground" : toneClass}`} />
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className={`font-mono text-sm font-semibold ${toneClass}`} data-testid={testId}>
          {value}
        </div>
      </div>
    </div>
  );
}
