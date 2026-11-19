// Extracted from ./SmartTransferGeneratorDialog.tsx
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type StockMeta } from "./smartTransferGeneratorTypes";

export function MultiSelectPopover({
  label,
  items,
  selected,
  onChange,
}: {
  label: string;
  items: StockMeta[];
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-between font-normal">
          <span className="truncate">{selected.length > 0 ? `${label} (${selected.length})` : `All ${label}`}</span>
          <ChevronDown className="h-4 w-4 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="flex items-center justify-between px-2 pb-2">
          <p className="text-sm font-medium">{label}</p>
          {selected.length > 0 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange([])}>
              Clear
            </Button>
          )}
        </div>
        <ScrollArea className="h-56">
          <div className="space-y-1 pr-2">
            {items.map((item) => (
              <label
                key={item.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-muted"
              >
                <Checkbox
                  checked={selected.includes(item.id)}
                  onCheckedChange={() =>
                    onChange(
                      selected.includes(item.id) ? selected.filter((id) => id !== item.id) : [...selected, item.id]
                    )
                  }
                />
                <span className="text-sm">{item.name}</span>
              </label>
            ))}
            {items.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted-foreground">No options</p>}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
