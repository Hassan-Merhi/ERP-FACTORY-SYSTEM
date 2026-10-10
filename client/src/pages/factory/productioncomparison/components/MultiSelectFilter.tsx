/**
 * MultiSelectFilter — extracted sub-component.
 *
 * Extracted from ProductionComparison.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** An option is either a plain string (value === label) or an explicit value/label pair. */
export type MultiSelectOption = string | { value: string; label: string };

export function MultiSelectFilter({
  options,
  selected,
  onChange,
  placeholder,
  allLabel,
  className,
  testId,
}: {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  allLabel: string;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);

  const normalized = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const label =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (normalized.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          className={cn(
            "inline-flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-xs hover:bg-accent transition-colors min-w-[140px]",
            selected.length > 0 && "border-primary/50",
            className
          )}
        >
          <span className="truncate">{label}</span>
          <div className="flex items-center gap-1 shrink-0">
            {selected.length > 0 && (
              <span
                role="button"
                tabIndex={0}
                className="rounded-full hover:bg-muted p-0.5"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange([]);
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), onChange([]))}
              >
                <X className="h-3 w-3 text-muted-foreground" />
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${placeholder.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup>
              {normalized.map((opt) => {
                const checked = selected.includes(opt.value);
                return (
                  <CommandItem
                    key={opt.value}
                    value={opt.label}
                    onSelect={() => toggle(opt.value)}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <div
                      className={cn(
                        "flex h-4 w-4 items-center justify-center rounded-sm border shrink-0",
                        checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                      )}
                    >
                      {checked && <Check className="h-3 w-3" />}
                    </div>
                    <span className="truncate">{opt.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
