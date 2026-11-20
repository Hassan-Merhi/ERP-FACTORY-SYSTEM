import * as React from "react";
import { Loader2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SearchFieldProps extends Omit<
  React.ComponentProps<typeof Input>,
  "type" | "value" | "onChange" | "defaultValue"
> {
  value: string;
  onValueChange: (value: string) => void;
  /** Styles the outer search container instead of its input. */
  wrapperClassName?: string;
  /** Use false when the surrounding workflow has its own clear action. */
  showClear?: boolean;
  clearTestId?: string;
  /** Clear the query with Escape when the owner has no competing Escape behavior. */
  clearOnEscape?: boolean;
  /** Show a spinner and prevent edits while results are being loaded. */
  loading?: boolean;
}

/**
 * One controlled search input for tables, side panels and lookup forms.
 * All query/debounce/selection behavior stays in the owner.
 */
export const SearchField = React.forwardRef<HTMLInputElement, SearchFieldProps>(
  (
    {
      value,
      onValueChange,
      wrapperClassName,
      showClear = true,
      clearTestId = "button-clear-search",
      clearOnEscape = false,
      loading = false,
      className,
      onKeyDown,
      placeholder = "Search...",
      "aria-label": ariaLabel,
      ...props
    },
    ref
  ) => {
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const setInputRef = React.useCallback(
      (node: HTMLInputElement | null) => {
        inputRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref]
    );
    const clear = () => {
      onValueChange("");
      // The clear control disappears when the value empties; restore its focus
      // to the still-mounted input instead of losing keyboard position.
      inputRef.current?.focus({ preventScroll: true });
    };
    return (
      <div className={cn("relative min-w-0 w-full", wrapperClassName)}>
        {loading ? (
          <Loader2
            className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <Search
            className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <Input
          {...props}
          disabled={loading || props.disabled}
          aria-busy={loading || undefined}
          ref={setInputRef}
          type="search"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented || event.key !== "Escape") return;
            if (clearOnEscape && value) {
              event.preventDefault();
              clear();
            } else {
              // WebKit/Chrome clear type="search" inputs natively on Escape; keep
              // the owner's opt-in the only path and let overlays handle the key.
              event.preventDefault();
            }
          }}
          placeholder={placeholder}
          aria-label={ariaLabel ?? placeholder}
          className={cn("min-h-11 w-full ps-9 sm:min-h-9 [&::-webkit-search-cancel-button]:hidden", showClear && "pe-11 sm:pe-9", className)}
        />
        {showClear && value.length > 0 ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="absolute end-0 top-1/2 h-11 w-11 -translate-y-1/2 sm:end-1 sm:h-8 sm:w-8"
            aria-label="Clear search"
            disabled={loading}
            data-testid={clearTestId}
            onClick={clear}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    );
  }
);
SearchField.displayName = "SearchField";
