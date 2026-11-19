// Extracted from ./PriceListToolbar.tsx
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PosPriceListModel } from "./usePosPriceListModel";

export function PriceListUnpricedGroups({ model }: { model: PosPriceListModel }) {
  const { selectedLocationId, showUnpriced, unpricedByGroup, hiddenUnpricedGroups } = model;
  if (!selectedLocationId || !showUnpriced || unpricedByGroup.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5 border-b shrink-0">
      <span className="text-xs font-medium text-muted-foreground shrink-0">Groups</span>
      <div className="w-px h-3.5 bg-border shrink-0" />
      <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
        {unpricedByGroup.map(({ name, count }) => {
          const isHidden = hiddenUnpricedGroups.has(name);
          return (
            <button
              key={name}
              data-testid={`chip-unpriced-group-${name}`}
              onClick={() => model.toggleHiddenUnpricedGroup(name)}
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-all",
                isHidden
                  ? "bg-muted/40 text-muted-foreground border-transparent opacity-50"
                  : "bg-muted text-foreground border-transparent hover-elevate"
              )}
            >
              <span>{name}</span>
              <span
                className={cn(
                  "inline-flex items-center justify-center min-w-[1.1rem] h-4 px-1 rounded-sm text-[11px] font-bold",
                  isHidden
                    ? "bg-muted-foreground/15 text-muted-foreground"
                    : "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs px-2 text-muted-foreground"
          onClick={() => model.setHiddenUnpricedGroups(new Set())}
          data-testid="button-show-all-unpriced-groups"
        >
          <Eye className="w-3 h-3 mr-1" />
          Show All
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs px-2 text-muted-foreground"
          onClick={() => model.setHiddenUnpricedGroups(new Set(unpricedByGroup.map((g) => g.name)))}
          data-testid="button-hide-all-unpriced-groups"
        >
          <EyeOff className="w-3 h-3 mr-1" />
          Hide All
        </Button>
      </div>
    </div>
  );
}
