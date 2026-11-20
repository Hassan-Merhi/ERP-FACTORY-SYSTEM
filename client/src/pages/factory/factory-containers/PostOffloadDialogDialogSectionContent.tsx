import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./PostOffloadDialogDialogSection.tsx
import { Fragment } from "react";
import { Info, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePostOffloadDialogState } from "./usePostOffloadDialogState";

export function PostOffloadDialogDialogSectionContent({
  container,
  ledgerAccounts,
  newCharges,
  setNewCharges,
  setTxDate,
  txDate,
}: Pick<
  Pick<
    ReturnType<typeof usePostOffloadDialogState>,
    | "activeCharges"
    | "chargeHistory"
    | "container"
    | "createResult"
    | "handleClose"
    | "historyExpanded"
    | "ledgerAccounts"
    | "newCharges"
    | "postOffloadMutation"
    | "setCreateResult"
    | "setHistoryExpanded"
    | "setNewCharges"
    | "setTxDate"
    | "setUndoCharge"
    | "setUndoDate"
    | "setUndoLegacyRate"
    | "startEdit"
    | "txDate"
    | "undoneCharges"
    | "wrapAdminAction"
  >,
  "container" | "ledgerAccounts" | "newCharges" | "setNewCharges" | "setTxDate" | "txDate"
>) {
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 p-3 rounded-md bg-blue-50 dark:bg-blue-950/20 text-blue-800 dark:text-blue-300 text-sm">
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <p>Enter charges that arrived after the original offload — port fees, duties, handling, etc.</p>
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Date</label>
        <Input
          type="date"
          value={txDate}
          onChange={(e) => setTxDate(e.target.value)}
          className="w-48"
          data-testid="input-post-offload-date"
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-1">
          <label className="text-sm font-medium">New Charges</label>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setNewCharges((prev) => [
                ...prev,
                {
                  id: Date.now().toString(),
                  description: "",
                  amount: "",
                  currencyCode: container?.currencyCode || "USD",
                  ledgerAccountId: "",
                  supplierId: "",
                },
              ])
            }
            data-testid="button-add-post-offload-charge-row"
          >
            <Plus className="h-3 w-3 mr-1" /> Add Row
          </Button>
        </div>
        {newCharges.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center border rounded-md">
            No charges added yet — click "Add Row" to begin.
          </p>
        ) : (
          <div className="space-y-1">
            <div className="grid grid-cols-[2fr_1fr_auto_2fr_auto] gap-x-2 gap-y-1 items-center">
              <div className="text-xs text-muted-foreground font-medium">Description</div>
              <div className="text-xs text-muted-foreground font-medium">Amount</div>
              <div className="text-xs text-muted-foreground font-medium">CCY</div>
              <div className="text-xs text-muted-foreground font-medium">Account / Broker</div>
              <div />
              {newCharges.map((charge, idx) => (
                <Fragment key={charge.id}>
                  <Input
                    value={charge.description}
                    onChange={(e) =>
                      setNewCharges((prev) =>
                        prev.map((c) => (c.id === charge.id ? { ...c, description: e.target.value } : c))
                      )
                    }
                    placeholder="e.g. Port duty"
                    data-testid={`input-poc-description-${idx}`}
                  />
                  <Input
                    type="number"
                    value={charge.amount}
                    onChange={(e) =>
                      setNewCharges((prev) =>
                        prev.map((c) => (c.id === charge.id ? { ...c, amount: e.target.value } : c))
                      )
                    }
                    placeholder="0.00"
                    step="0.01"
                    data-testid={`input-poc-amount-${idx}`}
                  />
                  <Select
                    value={charge.currencyCode || "USD"}
                    onValueChange={(v) =>
                      setNewCharges((prev) => prev.map((c) => (c.id === charge.id ? { ...c, currencyCode: v } : c)))
                    }
                  >
                    <SelectTrigger className="w-20" data-testid={`select-poc-currency-${idx}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["USD", "EUR", "GBP", "AUD", "LBP"].map((ccy) => (
                        <SelectItem key={ccy} value={ccy}>
                          {ccy}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <UnifiedAccountPicker
                    options={ledgerAccounts
                      .filter((a) => a.isPostingLeaf !== false)
                      .map((a) => ({ value: String(a.id), name: String(a.name ?? "") }))}
                    value={charge.ledgerAccountId || ""}
                    onChange={(v) =>
                      setNewCharges((prev) =>
                        prev.map((c) => (c.id === charge.id ? { ...c, ledgerAccountId: v, supplierId: "" } : c))
                      )
                    }
                    placeholder={"Select account (optional)"}
                    testId={`select-poc-account-${idx}`}
                    allowClear
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setNewCharges((prev) => prev.filter((c) => c.id !== charge.id))}
                    data-testid={`button-remove-poc-${idx}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </Fragment>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
