import type { ReactNode } from "react";
import { Check, ShoppingCart } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";

interface PosSaleHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Decorative content shown between the title and the actions (the seasonal artwork). */
  decoration?: ReactNode;
  actions?: ReactNode;
}

/**
 * The sale screen header card shared by ERP POS and Retail POS: icon, title, subtitle and the
 * screen's action buttons. Wraps on narrow screens so actions never push the page sideways.
 */
export function PosSaleHeader({ title, subtitle, decoration, actions }: PosSaleHeaderProps) {
  return (
    <div data-pos-header-inner="true" className="flex-wrap">
      <div data-pos-header-identity="true" className="flex min-w-0 items-center gap-4">
        <div data-pos-title-icon="true">
          <ShoppingCart className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {decoration}
      <div data-pos-header-actions="true" className="flex shrink-0 flex-wrap items-center gap-2">
        {actions}
      </div>
    </div>
  );
}

interface PosSaleSubmitButtonProps extends Omit<ButtonProps, "children"> {
  label: ReactNode;
  pending: boolean;
  pendingLabel: ReactNode;
  /** Show the check mark beside the label (header and checkout buttons). */
  showIcon?: boolean;
}

/**
 * The button that saves or completes a sale. Each screen passes its own handler, disabled rule
 * and labels; the button only renders them.
 */
export function PosSaleSubmitButton({
  label,
  pending,
  pendingLabel,
  showIcon = true,
  className,
  ...buttonProps
}: PosSaleSubmitButtonProps) {
  return (
    <Button className={["gap-2", className].filter(Boolean).join(" ")} {...buttonProps}>
      {pending ? (
        pendingLabel
      ) : (
        <>
          {showIcon && <Check className="h-4 w-4" aria-hidden="true" />}
          {label}
        </>
      )}
    </Button>
  );
}
