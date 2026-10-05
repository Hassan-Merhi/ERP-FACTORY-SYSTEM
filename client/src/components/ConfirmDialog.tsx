import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react";

export type ConfirmDialogTone = "default" | "destructive" | "warning";

export interface ConfirmDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: ConfirmDialogTone;
  icon?: LucideIcon;
  requirePhrase?: string;
  doubleConfirm?: { title: string; description?: React.ReactNode; confirmText?: string };
  loading?: boolean;
  confirmDisabled?: boolean;
  children?: React.ReactNode;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
  "data-testid"?: string;
}

export function ConfirmDialog({
  open: controlledOpen,
  onOpenChange,
  trigger,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  tone = "default",
  icon: Icon,
  requirePhrase,
  doubleConfirm,
  loading: externalLoading,
  confirmDisabled,
  children,
  onConfirm,
  onCancel,
  "data-testid": testId,
}: ConfirmDialogProps) {
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? !!controlledOpen : uncontrolledOpen;
  const setOpen = (value: boolean) => {
    if (!isControlled) setUncontrolledOpen(value);
    onOpenChange?.(value);
  };

  const [stage, setStage] = useState<1 | 2>(1);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setStage(1);
      setPhrase("");
      setBusy(false);
    }
  }, [open]);

  const isLoading = busy || !!externalLoading;
  const phraseMatches = !requirePhrase || phrase.trim() === requirePhrase.trim();

  const handlePrimary = async (event: React.MouseEvent | React.SyntheticEvent) => {
    event.preventDefault();
    if (!phraseMatches || isLoading || confirmDisabled) return;
    if (doubleConfirm && stage === 1) {
      setStage(2);
      return;
    }
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = () => {
    if (isLoading) return;
    onCancel?.();
    setOpen(false);
  };

  const ResolvedIcon = Icon ?? (tone === "destructive" || tone === "warning" ? AlertTriangle : null);
  const showSecond = doubleConfirm && stage === 2;
  const headerTitle = showSecond ? doubleConfirm!.title : title;
  const headerDescription = showSecond ? doubleConfirm!.description : description;
  const primaryLabel = showSecond ? (doubleConfirm!.confirmText ?? confirmText) : confirmText;

  const primaryClassName =
    tone === "destructive" || showSecond
      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
      : tone === "warning"
        ? "bg-warning text-warning-foreground hover:bg-warning/90"
        : "";

  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => !isLoading && setOpen(nextOpen)}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent
        data-testid={testId ?? "dialog-confirm"}
        aria-busy={isLoading ? "true" : undefined}
        className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-lg overflow-hidden p-0"
      >
        <div className="overflow-y-auto p-5 sm:p-6">
          <AlertDialogHeader>
            <div className="flex min-w-0 items-start gap-3">
              {ResolvedIcon && (
                <div
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
                    tone === "destructive" && "bg-destructive-soft text-destructive",
                    tone === "warning" && "bg-warning-soft text-warning-soft-foreground",
                    tone === "default" && "bg-primary/10 text-primary"
                  )}
                >
                  <ResolvedIcon className="h-5 w-5" aria-hidden="true" />
                </div>
              )}
              <div className="min-w-0 flex-1 text-left">
                <AlertDialogTitle className="break-words">{headerTitle}</AlertDialogTitle>
                {headerDescription && (
                  <AlertDialogDescription className="mt-1 whitespace-pre-line break-words leading-5">
                    {headerDescription}
                  </AlertDialogDescription>
                )}
              </div>
            </div>
          </AlertDialogHeader>

          {!showSecond && children && <div className="mt-4 min-w-0 space-y-3">{children}</div>}

          {!showSecond && requirePhrase && (
            <div className="mt-4 space-y-2">
              <Label htmlFor="confirm-phrase" className="text-xs">
                Type <span className="font-mono font-semibold">{requirePhrase}</span> to confirm
              </Label>
              <Input
                id="confirm-phrase"
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
                autoComplete="off"
                disabled={isLoading}
                data-testid="input-confirm-phrase"
              />
            </div>
          )}
        </div>

        <AlertDialogFooter className="border-t bg-muted/20 p-4 sm:flex-row sm:justify-end sm:px-6">
          <AlertDialogCancel
            onClick={handleCancel}
            disabled={isLoading}
            className="w-full sm:w-auto"
            data-testid="button-confirm-cancel"
          >
            {cancelText}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handlePrimary}
            disabled={isLoading || !phraseMatches || !!confirmDisabled}
            data-testid="button-confirm-confirm"
            className={cn("w-full sm:w-auto", primaryClassName)}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Working...
              </>
            ) : (
              primaryLabel
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
