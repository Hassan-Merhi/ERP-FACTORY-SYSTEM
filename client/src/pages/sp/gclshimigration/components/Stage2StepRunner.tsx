/**
 * Stage2StepRunner — extracted sub-component.
 *
 * Extracted from GcLshiMigration.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, Play, Lock, type LucideIcon } from "lucide-react";

export function Stage2StepRunner({
  label,
  Icon,
  endpoint,
  sourceCompanyId,
  targetCompanyId,
  sourceCompanyName,
  disabled,
  disabledReason,
  onDone,
}: {
  label: string;
  Icon: LucideIcon;
  endpoint: string;
  sourceCompanyId: number;
  targetCompanyId: number;
  sourceCompanyName?: string;
  disabled?: boolean;
  disabledReason?: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [result, setResult] = useState<{
    rowsCreated?: number;
    summary?: string[];
    warnings?: string[];
  } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", endpoint, {
        sourceCompanyId,
        targetCompanyId,
        companyNameConfirm: confirmName,
        confirmation: "MIGRATE",
      });
      return res;
    },
    onSuccess: async (data) => {
      const r = await data.json();
      setResult(r);
      setRunError(null);
      setConfirmOpen(false);
      setConfirmName("");
      toast({ title: `${label} complete`, description: `${r.rowsCreated} row(s) created.` });
      onDone();
    },
    onError: (e) => {
      setRunError(e.message);
      toast({ title: `${label} failed`, description: e.message, variant: "destructive" });
    },
  });

  return (
    <div className={`border rounded-md p-3 space-y-2 ${disabled ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {label}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (disabled) {
              toast({ title: "Step locked", description: disabledReason, variant: "destructive" });
              return;
            }
            setConfirmOpen(true);
          }}
          data-testid={`button-run-${endpoint.split("/").pop()}`}
        >
          {disabled ? <Lock className="h-3 w-3 mr-1" /> : <Play className="h-3 w-3 mr-1" />}
          Run
        </Button>
      </div>
      {disabled && disabledReason && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Lock className="h-3 w-3" /> {disabledReason}
        </p>
      )}
      {runError && (
        <p className="text-xs text-destructive" data-testid="text-step-error">
          {runError}
        </p>
      )}
      {result && (
        <div className="text-xs space-y-1 bg-muted/50 rounded p-2">
          {(result.summary ?? []).map((s: string, i: number) => (
            <p key={i}>{s}</p>
          ))}
          {(result.warnings ?? []).length > 0 && (
            <div className="text-amber-600 dark:text-amber-400 space-y-0.5 mt-1">
              {(result.warnings ?? []).map((w, i: number) => (
                <p key={i} className="flex gap-1">
                  <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" /> {w}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !mutation.isPending && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm: {label}</AlertDialogTitle>
            <AlertDialogDescription>
              Type the source company name exactly to confirm:
              <strong className="block mt-1">{sourceCompanyName}</strong>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <Input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={sourceCompanyName}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => mutation.mutate()}
              disabled={confirmName !== sourceCompanyName || mutation.isPending}
            >
              {mutation.isPending ? "Running…" : "Run"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Profit-share opening balance runner ─────────────────────────────────────
