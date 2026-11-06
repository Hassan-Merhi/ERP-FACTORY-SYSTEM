import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { applicationEnglishTranslations } from "@/i18n/applicationTranslations";

export const OPERATOR_REASON_MIN = 10;

/** Machine code from a failed operator request (shown to the operator as is). */
export function operatorErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  const text = error instanceof Error ? error.message : String(error);
  return /"code":"([A-Z0-9_]+)"/.exec(text)?.[1] ?? "EDGE_OPERATOR_REQUEST_FAILED";
}

/**
 * Reason + password confirmation for the Phase 10 operator buttons. The
 * password is sent once with the request and never kept.
 */
export function FactoryEdgeOperatorConfirmDialog({
  open,
  title,
  description,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (input: { reason: string; password: string }) => void;
}) {
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const language = useOptionalApplicationLanguage();
  const t = language?.t ?? ((key: keyof typeof applicationEnglishTranslations) => applicationEnglishTranslations[key]);
  const ready = reason.trim().length >= OPERATOR_REASON_MIN && password.length > 0 && !pending;
  const close = () => {
    setReason("");
    setPassword("");
    onCancel();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && close()}>
      <DialogContent data-testid="factory-edge-operator-confirm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="edge-operator-reason" className="text-sm font-medium">
              {t("edge.operator.reason")}
            </label>
            <Textarea
              id="edge-operator-reason"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              data-testid="input-edge-operator-reason"
            />
            <p className="text-xs text-muted-foreground">{t("edge.operator.reasonHint")}</p>
          </div>
          <div className="space-y-1">
            <label htmlFor="edge-operator-password" className="text-sm font-medium">
              {t("edge.operator.password")}
            </label>
            <Input
              id="edge-operator-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="input-edge-operator-password"
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive" data-testid="text-edge-operator-error">
              {t("edge.operator.actionFailed")}: {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={pending} data-testid="button-edge-operator-cancel">
            {t("edge.operator.cancel")}
          </Button>
          <Button
            onClick={() => {
              onConfirm({ reason: reason.trim(), password });
              setPassword("");
            }}
            disabled={!ready}
            data-testid="button-edge-operator-confirm"
          >
            {t("edge.operator.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
