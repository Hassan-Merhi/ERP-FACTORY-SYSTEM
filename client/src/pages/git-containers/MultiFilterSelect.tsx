import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronDown, Search, X } from "lucide-react";
import { useState } from "react";

export interface MultiOption {
  label: string;
  value: string;
  dividerBefore?: boolean;
}

export function MultiFilterSelect({
  allLabel,
  options,
  selected,
  onChange,
  testId,
  searchable = false,
}: {
  allLabel: string;
  options: MultiOption[];
  selected: string[];
  onChange: (vals: string[]) => void;
  testId?: string;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");

  const toggle = (val: string) => {
    onChange(selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]);
  };

  const visibleOptions =
    searchable && query.trim() ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase())) : options;

  const triggerLabel =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs w-full justify-between font-normal px-2"
          data-testid={testId}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 ml-1 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        {searchable && (
          <div className="flex items-center gap-1 px-1 pb-1 border-b mb-1">
            <Search className="h-3 w-3 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search..."
              className="flex-1 text-xs bg-transparent outline-hidden placeholder:text-muted-foreground py-1"
            />
            {query && (
              <button onClick={() => setQuery("")} className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
        <div className="max-h-56 overflow-y-auto">
          {visibleOptions.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">No results</p>
          ) : (
            visibleOptions.map((opt) => (
              <div key={opt.value}>
                {opt.dividerBefore && <div className="border-t my-1" />}
                <div
                  className="flex items-center gap-2 px-2 py-1.5 rounded-xs cursor-pointer hover-elevate text-xs"
                  onClick={() => toggle(opt.value)}
                >
                  <Checkbox
                    checked={selected.includes(opt.value)}
                    onCheckedChange={() => toggle(opt.value)}
                    className="h-3 w-3 shrink-0"
                  />
                  <span className="truncate">{opt.label}</span>
                </div>
              </div>
            ))
          )}
        </div>
        {selected.length > 0 && (
          <div className="border-t mt-1 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-full text-xs text-muted-foreground"
              onClick={() => onChange([])}
            >
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
