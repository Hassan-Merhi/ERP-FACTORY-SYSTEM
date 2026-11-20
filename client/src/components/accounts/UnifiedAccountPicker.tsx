import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { searchAny } from "@shared/searchNormalization";
import { cn } from "@/lib/utils";

export type AccountPickerChoice = {
  /** Stable opaque posting key, e.g. "123" or "ledger:123". */
  value: string;
  /** Only the account name is displayed or searched. */
  name: string;
  disabled?: boolean;
};

type CommonProps = {
  options: readonly AccountPickerChoice[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  id?: string;
  testId?: string;
  searchTestId?: string;
  optionTestId?: (value: string) => string;
  ariaLabel?: string;
  className?: string;
  contentClassName?: string;
  maxResults?: number;
};

type SingleProps = CommonProps & {
  mode?: "single";
  value: string;
  onChange: (value: string) => void;
  selectedFallbackName?: string;
  allowClear?: boolean;
  clearLabel?: string;
};

type MultiProps = CommonProps & {
  mode: "multiple";
  selectedValues: readonly string[];
  onSelectedValuesChange: (values: string[]) => void;
  clearLabel?: string;
};

export type UnifiedAccountPickerProps = SingleProps | MultiProps;

/** Search names only: codes, IDs and account types must never influence results. */
export function filterAccountPickerChoices(
  options: readonly AccountPickerChoice[],
  query: string,
  limit = 250
): AccountPickerChoice[] {
  return options.filter((account) => searchAny(query, account.name)).slice(0, limit);
}

/**
 * One account picker for ERP, Factory, Properties, POS and Retail.
 * The caller retains all authorization, account eligibility and ID semantics.
 * Display and search always use names only; accounting IDs remain unchanged.
 */
export function UnifiedAccountPicker(props: UnifiedAccountPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const multiple = props.mode === "multiple";
  const values = props.mode === "multiple" ? props.selectedValues : [props.value];
  const selected = props.mode === "multiple" ? null : props.options.find((option) => option.value === props.value);
  const filtered = useMemo(
    () => filterAccountPickerChoices(props.options, query, props.maxResults ?? 250),
    [props.options, query, props.maxResults]
  );
  const selectedSet = new Set(values);
  const placeholder = props.placeholder ?? "Select account...";
  const label = props.mode === "multiple"
    ? values.length
      ? `${values.length} account${values.length === 1 ? "" : "s"} selected`
      : placeholder
    : selected?.name || props.selectedFallbackName || placeholder;

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const handleSelection = (value: string) => {
    if (props.mode === "multiple") {
      const current = props.selectedValues;
      props.onSelectedValuesChange(
        current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
      );
      return;
    }
    props.onChange(value);
    changeOpen(false);
  };

  const handleClear = () => {
    if (props.mode === "multiple") props.onSelectedValuesChange([]);
    else props.onChange("");
    changeOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          id={props.id}
          type="button"
          variant="outline"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={props.ariaLabel ?? placeholder}
          disabled={props.disabled}
          data-testid={props.testId}
          className={cn("min-h-11 w-full justify-between gap-2 px-3 font-normal sm:min-h-9", props.className)}
          title={label}
        >
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("w-[min(420px,calc(100vw-2rem))] p-0", props.contentClassName)}
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={props.searchPlaceholder ?? "Search account name..."}
            aria-label="Search accounts..."
            data-testid={props.searchTestId ?? (props.testId ? `${props.testId}-search` : undefined)}
          />
          <CommandList className="max-h-64">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {props.emptyMessage ?? "No matching accounts."}
              </p>
            ) : (
              <CommandGroup>
                {filtered.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    onSelect={() => handleSelection(option.value)}
                    data-testid={props.optionTestId?.(option.value)}
                  >
                    <Check
                      className={cn(
                        "h-4 w-4 shrink-0",
                        selectedSet.has(option.value) ? "opacity-100" : "opacity-0"
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {filtered.length >= (props.maxResults ?? 250) ? (
              <p className="px-3 pb-2 text-xs text-muted-foreground">
                Showing first {props.maxResults ?? 250} matches. Refine your search.
              </p>
            ) : null}
          </CommandList>
          {(props.mode === "multiple" ? values.length > 0 : props.allowClear && Boolean(props.value)) && (
            <div className="border-t p-2 text-right">
              <Button type="button" size="sm" variant="ghost" onClick={handleClear}>
                {props.clearLabel ?? (multiple ? "Clear all" : "Clear account")}
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
