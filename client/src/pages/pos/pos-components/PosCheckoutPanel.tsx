import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PosCheckoutPanelProps {
  ariaLabel: string;
  /** ERP POS shows this strip from `lg` only (its phone layout has its own fields). */
  desktopOnly?: boolean;
  children: ReactNode;
}

/**
 * The sale and payment details strip shared by both sale screens: location, date, payment
 * method/account and customer. Each screen passes its own controls; nothing is computed here.
 */
export function PosCheckoutPanel({ ariaLabel, desktopOnly = false, children }: PosCheckoutPanelProps) {
  return (
    <section
      data-pos-checkout-strip="true"
      aria-label={ariaLabel}
      className={cn("flex-wrap gap-3", desktopOnly ? "hidden lg:flex items-center px-4 py-3" : "flex items-start")}
    >
      {children}
    </section>
  );
}

interface PosCheckoutFieldProps {
  /** Names the field for styling and tests (`data-pos-checkout-field`). */
  field: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  label: ReactNode;
  /** Id of the control the label names; without it the label is plain text. */
  htmlFor?: string;
  children: ReactNode;
}

/** One labelled field card inside {@link PosCheckoutPanel}. */
export function PosCheckoutField({ field, icon: Icon, label, htmlFor, children }: PosCheckoutFieldProps) {
  const labelContent = (
    <>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </>
  );
  return (
    <div data-pos-checkout-field={field} className="pos-checkout-field">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="pos-checkout-field-label">
          {labelContent}
        </label>
      ) : (
        <span className="pos-checkout-field-label">{labelContent}</span>
      )}
      {children}
    </div>
  );
}
