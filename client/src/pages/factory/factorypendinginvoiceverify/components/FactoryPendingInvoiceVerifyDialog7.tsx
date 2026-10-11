import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RefreshCw } from "lucide-react";
import type { useFactoryPendingInvoiceVerifyModel } from "../useFactoryPendingInvoiceVerifyModel";

type Model = ReturnType<typeof useFactoryPendingInvoiceVerifyModel>;

export function FactoryPendingInvoiceVerifyDialog7({ model }: { model: Model }) {
  const {
    showRecoverDialog,
    setShowRecoverDialog,
    recoverInput,
    setRecoverInput,
    recoverTab,
    setRecoverTab,
    recoverBalesMutation,
    autoRecoverMutation,
    isPending: _isPending,
  } = model;
  return (
    <Dialog
      open={showRecoverDialog}
      onOpenChange={(open) => {
        setShowRecoverDialog(open);
        if (!open) setRecoverTab("auto");
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Recover Bales (Admin)</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* Tab switcher */}
          <div className="flex rounded-md border overflow-hidden text-sm">
            <button
              className={`flex-1 px-3 py-2 font-medium transition-colors ${recoverTab === "auto" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover-elevate"}`}
              onClick={() => setRecoverTab("auto")}
              data-testid="tab-auto-recover"
            >
              Auto-Recover from Stock
            </button>
            <button
              className={`flex-1 px-3 py-2 font-medium transition-colors border-l ${recoverTab === "manual" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover-elevate"}`}
              onClick={() => setRecoverTab("manual")}
              data-testid="tab-manual-recover"
            >
              Manual by Reference
            </button>
          </div>

          {recoverTab === "auto" && (
            <>
              <p className="text-sm text-muted-foreground">
                Automatically finds bales from stock that match the proforma article codes for this order and links them
                — up to the expected quantity per article. Bales claimed by other active orders will be skipped.
              </p>
              <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <strong>Important:</strong> This picks bales by article code in insertion order (oldest first). Verify
                the results afterwards and use manual recovery if specific bale references are needed.
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowRecoverDialog(false)}
                  data-testid="button-cancel-recover"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => autoRecoverMutation.mutate()}
                  disabled={autoRecoverMutation.isPending}
                  data-testid="button-confirm-auto-recover"
                >
                  <RefreshCw className={`mr-2 h-4 w-4 ${autoRecoverMutation.isPending ? "animate-spin" : ""}`} />
                  {autoRecoverMutation.isPending ? "Recovering…" : "Auto-Recover from Stock"}
                </Button>
              </div>
            </>
          )}

          {recoverTab === "manual" && (
            <>
              <p className="text-sm text-muted-foreground">
                Paste the bale reference numbers that should be linked to this order — one per line. Each reference will
                be looked up and re-linked here. Bales already linked to another active order will be skipped.
              </p>
              <Textarea
                value={recoverInput}
                onChange={(e) => setRecoverInput(e.target.value)}
                placeholder={"BAL-001\nBAL-002\nBAL-003"}
                rows={8}
                className="font-mono text-sm"
                data-testid="input-recover-bales"
              />
              <p className="text-xs text-muted-foreground">
                SQL to find available bales:
                <code className="block mt-1 p-2 bg-muted rounded-sm text-xs whitespace-pre-wrap">
                  {`SELECT reference_number, article_code, status\nFROM factory_bales\nWHERE status IN ('SOLD','RESERVED_FOR_ORDER','IN_STOCK')\nAND NOT EXISTS (\n  SELECT 1 FROM customer_order_bales cob\n  WHERE cob.bale_id = factory_bales.id\n)\nORDER BY updated_at DESC;`}
                </code>
              </p>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowRecoverDialog(false)}
                  data-testid="button-cancel-recover"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    const refs = recoverInput
                      .split("\n")
                      .map((r) => r.trim())
                      .filter(Boolean);
                    if (refs.length === 0) return;
                    recoverBalesMutation.mutate(refs);
                  }}
                  disabled={recoverBalesMutation.isPending || !recoverInput.trim()}
                  data-testid="button-confirm-recover"
                >
                  <RefreshCw className={`mr-2 h-4 w-4 ${recoverBalesMutation.isPending ? "animate-spin" : ""}`} />
                  {recoverBalesMutation.isPending
                    ? "Recovering…"
                    : `Recover ${recoverInput.split("\n").filter((r) => r.trim()).length} Bale(s)`}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
