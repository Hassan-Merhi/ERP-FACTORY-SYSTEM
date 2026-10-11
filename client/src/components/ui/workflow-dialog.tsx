import * as React from "react";
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type WorkflowDialogTone = "default" | "warning" | "destructive";

type WorkflowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  icon?: LucideIcon;
  tone?: WorkflowDialogTone;
  cancelLabel?: string;
  confirmLabel: string;
  onConfirm: () => void;
  confirmVariant?: ButtonProps["variant"];
  isPending?: boolean;
  disableConfirm?: boolean;
  contentClassName?: string;
  testId?: string;
};

const toneClasses: Record<WorkflowDialogTone, string> = {
  default: "bg-primary/10 text-primary",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

export function WorkflowDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  icon: Icon = AlertTriangle,
  tone = "default",
  cancelLabel = "Cancel",
  confirmLabel,
  onConfirm,
  confirmVariant,
  isPending = false,
  disableConfirm = false,
  contentClassName,
  testId,
}: WorkflowDialogProps) {
  const resolvedVariant = confirmVariant ?? (tone === "destructive" ? "destructive" : "default");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-h-[calc(var(--app-viewport-height)-1rem)] w-[calc(100vw-1rem)] overflow-hidden p-0 sm:max-w-lg",
          contentClassName
        )}
        data-testid={testId}
      >
        <div className="flex min-h-0 flex-col">
          <DialogHeader className="border-b px-4 py-4 text-left sm:px-6">
            <div className="flex min-w-0 items-start gap-3">
              <div className={cn("shrink-0 rounded-lg p-2", toneClasses[tone])}>
                <Icon className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="wrap-break-word">{title}</DialogTitle>
                {description ? (
                  <DialogDescription className="mt-1 wrap-break-word leading-5">{description}</DialogDescription>
                ) : null}
              </div>
            </div>
          </DialogHeader>

          {children ? <DialogBody className="px-4 py-4 sm:px-6">{children}</DialogBody> : null}

          <DialogFooter className="border-t bg-muted/20 px-4 py-3 sm:px-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {cancelLabel}
            </Button>
            <Button
              type="button"
              variant={resolvedVariant}
              onClick={onConfirm}
              disabled={disableConfirm || isPending}
              aria-busy={isPending ? "true" : undefined}
            >
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type { WorkflowDialogProps, WorkflowDialogTone };
