import type { ReactNode } from "react";
import { NotebookPen } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import "@/styles/pos-workspace-premium.css";

/**
 * Shared frame for the two sale screens (ERP POS and Retail POS).
 *
 * Presentation only: each screen keeps its own state, hooks, API calls, pricing and posting. The
 * frame carries `data-pos-modern-workspace`, which scopes the POS workspace stylesheet, so both
 * screens get the same header card, checkout fields, sale panel, cart grid and grand total.
 *
 * - `erp`: a full-height canvas that scrolls inside its panels (the shell gives it a fixed-height
 *   workspace) and has a separate phone layout.
 * - `retail`: flows with the page on every screen size, with room under it for the phone checkout bar.
 */
export function PosSaleScreen({ variant, children }: { variant: "erp" | "retail"; children: ReactNode }) {
  return (
    <div
      data-pos-modern-workspace="true"
      data-pos-sale-screen={variant}
      className={
        variant === "erp"
          ? "flex flex-col h-full bg-background overflow-hidden relative"
          : "mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-3 pb-24 md:p-5 xl:pb-5"
      }
    >
      {children}
    </div>
  );
}

/** The sale column: cart grid, notes and (retail) checkout, on one panel. */
export function PosSalePanel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div data-pos-sale-panel="true" className={cn("flex min-w-0 flex-col", className)}>
      {children}
    </div>
  );
}

/** Wraps the cart grid so it gets the panel's inner spacing. */
export function PosSaleGridWrap({ children }: { children: ReactNode }) {
  return <div data-pos-grid-wrap="true">{children}</div>;
}

interface PosSaleNotesProps {
  id: string;
  label: string;
  optionalLabel: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  testId: string;
  className?: string;
}

/** Sale notes: the same labelled field on both sale screens. */
export function PosSaleNotes({
  id,
  label,
  optionalLabel,
  placeholder,
  value,
  onChange,
  maxLength,
  testId,
  className,
}: PosSaleNotesProps) {
  return (
    <div data-pos-notes-wrap="true" className={cn("mt-2 px-1 pb-2", className)}>
      <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium">
        <NotebookPen className="h-4 w-4" aria-hidden="true" /> {label}{" "}
        <span className="text-muted-foreground font-normal">{optionalLabel}</span>
      </label>
      <Textarea
        id={id}
        placeholder={placeholder}
        value={value}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        className="resize-none h-12 min-h-[48px] text-sm"
        data-testid={testId}
      />
    </div>
  );
}
