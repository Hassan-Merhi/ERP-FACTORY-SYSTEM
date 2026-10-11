import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  RotateCcw,
  ShieldAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ActionFeedbackTone = "progress" | "success" | "warning" | "error" | "info";

type ActionFeedbackProps = React.HTMLAttributes<HTMLDivElement> & {
  tone?: ActionFeedbackTone;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionVariant?: ButtonProps["variant"];
  compact?: boolean;
  icon?: LucideIcon;
};

const toneConfig: Record<
  ActionFeedbackTone,
  { icon: LucideIcon; className: string; role: "status" | "alert"; live: "polite" | "assertive" }
> = {
  progress: { icon: Loader2, className: "border-info/30 bg-info/5 text-info", role: "status", live: "polite" },
  success: {
    icon: CheckCircle2,
    className: "border-success/30 bg-success/5 text-success",
    role: "status",
    live: "polite",
  },
  warning: {
    icon: AlertTriangle,
    className: "border-warning/30 bg-warning/5 text-warning",
    role: "status",
    live: "polite",
  },
  error: {
    icon: XCircle,
    className: "border-destructive/30 bg-destructive/5 text-destructive",
    role: "alert",
    live: "assertive",
  },
  info: { icon: Info, className: "border-info/30 bg-info/5 text-info", role: "status", live: "polite" },
};

export function ActionFeedback({
  tone = "info",
  title,
  description,
  actionLabel,
  onAction,
  actionVariant = "outline",
  compact = false,
  icon,
  className,
  ...props
}: ActionFeedbackProps) {
  const config = toneConfig[tone];
  const Icon = icon ?? config.icon;

  return (
    <div
      role={config.role}
      aria-live={config.live}
      aria-atomic="true"
      aria-busy={tone === "progress" ? "true" : undefined}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-lg border sm:flex-row sm:items-start",
        compact ? "px-3 py-2" : "p-4",
        config.className,
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon
          className={cn("mt-0.5 h-5 w-5 shrink-0", tone === "progress" && "animate-spin motion-reduce:animate-none")}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 text-foreground">
          <p className="wrap-break-word text-sm font-semibold">{title}</p>
          {description ? (
            <p className="mt-0.5 wrap-break-word text-sm leading-5 text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {actionLabel && onAction ? (
        <Button
          className="w-full shrink-0 sm:w-auto"
          size={compact ? "sm" : "default"}
          variant={actionVariant}
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function SavingFeedback(props: Omit<ActionFeedbackProps, "tone">) {
  return <ActionFeedback tone="progress" {...props} />;
}

export function SuccessFeedback(props: Omit<ActionFeedbackProps, "tone">) {
  return <ActionFeedback tone="success" {...props} />;
}

export function WarningFeedback(props: Omit<ActionFeedbackProps, "tone">) {
  return <ActionFeedback tone="warning" {...props} />;
}

export function ErrorFeedback(props: Omit<ActionFeedbackProps, "tone">) {
  return <ActionFeedback tone="error" {...props} />;
}

export function RecoveryFeedback(props: Omit<ActionFeedbackProps, "tone" | "icon">) {
  return <ActionFeedback tone="warning" icon={RotateCcw} actionVariant="outline" {...props} />;
}

export function ConfirmationFeedback(props: Omit<ActionFeedbackProps, "tone" | "icon">) {
  return <ActionFeedback tone="warning" icon={ShieldAlert} actionVariant="destructive" {...props} />;
}

export type { ActionFeedbackProps, ActionFeedbackTone };
