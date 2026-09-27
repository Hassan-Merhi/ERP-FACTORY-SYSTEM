import * as React from "react";

import { cn } from "@/lib/utils";

type TabsContextValue = {
  value: string | undefined;
  onValueChange: (value: string) => void;
};

const TabsContext = React.createContext<TabsContextValue>({
  value: undefined,
  onValueChange: () => {},
});

function Tabs({
  value: controlledValue,
  defaultValue,
  onValueChange,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}) {
  const [internalValue, setInternalValue] = React.useState<string | undefined>(defaultValue);

  const isControlled = controlledValue !== undefined;
  const activeValue = isControlled ? controlledValue : internalValue;

  const handleChange = React.useCallback(
    (val: string) => {
      if (!isControlled) setInternalValue(val);
      onValueChange?.(val);
    },
    [isControlled, onValueChange]
  );

  return (
    <TabsContext.Provider value={{ value: activeValue, onValueChange: handleChange }}>
      <div className={cn("min-w-0", className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

const TabsList = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { variant?: "pill" | "underline" }
>(({ className, variant = "pill", ...props }, ref) => (
  <div
    ref={ref}
    role="tablist"
    data-responsive-tabs="true"
    className={cn(
      "inline-flex max-w-full items-center justify-start gap-1 overflow-x-auto overscroll-x-contain touch-pan-x",
      variant === "pill" && "rounded-full border border-border bg-muted/40 p-1 text-muted-foreground",
      variant === "underline" && "border-b border-border bg-transparent p-0 text-muted-foreground",
      className
    )}
    {...props}
  />
));
TabsList.displayName = "TabsList";

const TabsTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }
>(({ className, value, onClick, children, ...props }, ref) => {
  const ctx = React.useContext(TabsContext);
  const active = ctx.value === value;
  const localRef = React.useRef<HTMLButtonElement | null>(null);
  const setRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      localRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref]
  );

  // A strip wider than a phone scrolls sideways; keep the active tab in view (horizontally only,
  // so selecting a tab or opening a deep link never scrolls the page itself).
  React.useEffect(() => {
    const node = localRef.current;
    const list = node?.closest<HTMLElement>('[role="tablist"]');
    if (!active || !node || !list || list.scrollWidth <= list.clientWidth) return;
    const listBox = list.getBoundingClientRect();
    const tabBox = node.getBoundingClientRect();
    if (tabBox.left < listBox.left) list.scrollLeft -= listBox.left - tabBox.left + 8;
    else if (tabBox.right > listBox.right) list.scrollLeft += tabBox.right - listBox.right + 8;
  }, [active]);

  return (
    <button
      ref={setRef}
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-state={active ? "active" : "inactive"}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) ctx.onValueChange(value);
      }}
      className={cn(
        "inline-flex min-h-11 shrink-0 touch-manipulation items-center justify-center gap-1.5 whitespace-nowrap text-sm font-medium transition-all sm:min-h-9",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:pointer-events-none disabled:opacity-40",
        "rounded-full px-3 py-1.5 text-muted-foreground hover:text-foreground sm:px-4",
        active && "bg-background font-semibold text-foreground shadow-sm",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
});
TabsTrigger.displayName = "TabsTrigger";

const TabsContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { value: string }>(
  ({ className, value, children, ...props }, ref) => {
    const ctx = React.useContext(TabsContext);

    if (ctx.value !== undefined && ctx.value !== value) return null;

    return (
      <div
        ref={ref}
        role="tabpanel"
        data-state={ctx.value === value ? "active" : "inactive"}
        className={cn(
          "mt-4 min-w-0 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);
TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };
