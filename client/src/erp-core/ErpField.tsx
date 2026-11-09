import * as React from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Controlled field adapter for ERP forms that do not use React Hook Form.
 * React Hook Form screens should continue using FormField/FormControl/FormMessage.
 * Caller-owned validation and values are never overridden.
 */
export interface ErpFieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-errormessage"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

export interface ErpFieldProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  id?: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  children: (controlProps: ErpFieldControlProps) => React.ReactNode;
}

export function ErpField({
  id: explicitId,
  label,
  description,
  error,
  required = false,
  children,
  className,
  ...props
}: ErpFieldProps) {
  const generatedId = React.useId();
  const id = explicitId ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  const controlProps: ErpFieldControlProps = {
    id,
    "aria-describedby": describedBy,
    "aria-errormessage": errorId,
    "aria-invalid": error ? true : undefined,
    "aria-required": required ? true : undefined,
  };

  return (
    <div className={cn("min-w-0 space-y-1.5", className)} data-erp-field="" {...props}>
      <Label htmlFor={id} className={cn("text-xs font-medium", error && "text-destructive")}>
        {label}
        {required ? <span aria-hidden="true" className="ml-1 text-destructive">*</span> : null}
      </Label>
      {children(controlProps)}
      {description ? <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      {error ? <p id={errorId} role="alert" className="text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
