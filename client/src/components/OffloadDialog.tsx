import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, X } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import { formatUsd } from "@/lib/moneyDisplay";
import { AccountCombobox, LocationCombobox } from "./OffloadDialogComboboxes";
import { useOffloadDialogModel } from "./OffloadDialogModel";

export interface OffloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  containerId: number;
  containerNumber: string;
  totalBales: number;
}

export function OffloadDialog({ open, onOpenChange, containerId, containerNumber, totalBales }: OffloadDialogProps) {
  const m = useOffloadDialogModel({ open, onOpenChange, containerId, containerNumber, totalBales });

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader className="pb-2">
          <DialogTitle className="text-lg">Offload Container {containerNumber}</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {m.isSpCompany
              ? "Set the offload date, enter any landed charges, and choose a destination location."
              : "Enter charges, select accounts, and choose a destination. The total cost per bale will be recalculated automatically."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={m.handleSubmit} className="space-y-5" noValidate>
          {/* Offload Date */}
          <div className="space-y-1.5">
            <Label htmlFor="offload-date" className="text-sm font-medium">
              Offload Date
            </Label>
            <Input
              id="offload-date"
              type="date"
              value={m.offloadDate}
              onChange={(e) => m.setOffloadDate(e.target.value)}
              data-testid="input-offload-date"
            />
          </div>

          {/* Charges section */}
          <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Landed Charges</p>

            {m.isSpCompany ? (
              <>
                {/* SP — Duties */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Duties</Label>
                  <div className="grid grid-cols-12 gap-2 items-start">
                    <div className="col-span-3">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="Amount"
                        value={m.spDutiesAmount}
                        onChange={(e) => m.setSpDutiesAmount(e.target.value)}
                        data-testid="input-sp-duties"
                      />
                    </div>
                    <div className="col-span-4">
                      <Select
                        value={m.spDutiesMethod}
                        onValueChange={(v) => {
                          m.setSpDutiesMethod(v as "prepaid_expenses" | "parent_agent");
                          m.setSpDutiesAgentId("");
                        }}
                      >
                        <SelectTrigger data-testid="select-sp-duties-method">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="prepaid_expenses">Prepaid Expenses</SelectItem>
                          <SelectItem value="parent_agent">Agent via HADI L&apos;SHI</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {m.spDutiesMethod === "prepaid_expenses" ? (
                      <div className="col-span-5 flex items-center h-9 px-3 rounded-md border bg-muted/40 text-sm text-muted-foreground">
                        {m.spPrepaidExpAcct?.name ?? "Prepaid Expenses"}
                      </div>
                    ) : (
                      <div className="col-span-5">
                        <Select value={m.spDutiesAgentId} onValueChange={m.setSpDutiesAgentId}>
                          <SelectTrigger data-testid="select-sp-duties-agent">
                            <SelectValue placeholder="Select agent" />
                          </SelectTrigger>
                          <SelectContent>
                            {m.parentAgents.map((a) => (
                              <SelectItem key={a.ledger_account_id} value={String(a.ledger_account_id)}>
                                {a.account_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                </div>

                {/* SP — Transport */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Transport</Label>
                  <div className="grid grid-cols-12 gap-2 items-start">
                    <div className="col-span-3">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="Amount"
                        value={m.spTransportAmount}
                        onChange={(e) => m.setSpTransportAmount(e.target.value)}
                        data-testid="input-sp-transport"
                      />
                    </div>
                    <div className="col-span-4">
                      <Select
                        value={m.spTransportMethod}
                        onValueChange={(v) => {
                          m.setSpTransportMethod(v as "prepaid_expenses" | "parent_agent");
                          m.setSpTransportAgentId("");
                        }}
                      >
                        <SelectTrigger data-testid="select-sp-transport-method">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="prepaid_expenses">Prepaid Expenses</SelectItem>
                          <SelectItem value="parent_agent">Agent via HADI L&apos;SHI</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {m.spTransportMethod === "prepaid_expenses" ? (
                      <div className="col-span-5 flex items-center h-9 px-3 rounded-md border bg-muted/40 text-sm text-muted-foreground">
                        {m.spPrepaidExpAcct?.name ?? "Prepaid Expenses"}
                      </div>
                    ) : (
                      <div className="col-span-5">
                        <Select value={m.spTransportAgentId} onValueChange={m.setSpTransportAgentId}>
                          <SelectTrigger data-testid="select-sp-transport-agent">
                            <SelectValue placeholder="Select agent" />
                          </SelectTrigger>
                          <SelectContent>
                            {m.parentAgents.map((a) => (
                              <SelectItem key={a.ledger_account_id} value={String(a.ledger_account_id)}>
                                {a.account_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* ERP — Duties */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Duties</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Amount"
                      value={m.duties}
                      onChange={(e) => m.setDuties(e.target.value)}
                      data-testid="input-duties"
                    />
                    <AccountCombobox
                      value={m.dutiesAccountId}
                      onValueChange={m.setDutiesAccountId}
                      accounts={m.ledgerAccounts}
                      placeholder="Select account"
                      disabled={parseFloat(m.duties) === 0}
                      testId="select-duties-account"
                    />
                  </div>
                </div>

                {/* ERP — Transport Fees */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Transport Fees</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Amount"
                      value={m.transportFees}
                      onChange={(e) => m.setTransportFees(e.target.value)}
                      data-testid="input-transport-fees"
                    />
                    <AccountCombobox
                      value={m.transportAccountId}
                      onValueChange={m.setTransportAccountId}
                      accounts={m.ledgerAccounts}
                      placeholder="Select account"
                      disabled={parseFloat(m.transportFees) === 0}
                      testId="select-transport-account"
                    />
                  </div>
                </div>

                {/* ERP — Additional Charges */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-sm font-medium text-muted-foreground">Additional Charges</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={m.handleAddCharge}
                      className="gap-1.5 h-7 text-xs"
                      data-testid="button-add-charge"
                    >
                      <Plus className="h-3 w-3" />
                      Add
                    </Button>
                  </div>
                  {m.additionalCharges.length > 0 && (
                    <div className="space-y-2">
                      {m.additionalCharges.map((charge) => (
                        <div key={charge.id} className="grid grid-cols-12 gap-2 items-start">
                          <Input
                            placeholder="Description"
                            value={charge.description}
                            onChange={(e) => m.handleUpdateCharge(charge.id, "description", e.target.value)}
                            className="col-span-4"
                            data-testid={`input-charge-description-${charge.id}`}
                          />
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="Amount"
                            value={charge.amount}
                            onChange={(e) => m.handleUpdateCharge(charge.id, "amount", e.target.value)}
                            className="col-span-3"
                            data-testid={`input-charge-amount-${charge.id}`}
                          />
                          <div className="col-span-4">
                            <AccountCombobox
                              value={charge.ledgerAccountId}
                              onValueChange={(value) => m.handleUpdateCharge(charge.id, "ledgerAccountId", value)}
                              accounts={m.ledgerAccounts}
                              placeholder="Select account"
                              testId={`select-charge-account-${charge.id}`}
                            />
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => m.handleRemoveCharge(charge.id)}
                            className="col-span-1"
                            data-testid={`button-remove-charge-${charge.id}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Destination Location */}
          <div className="space-y-1.5">
            <Label htmlFor="location" className="text-sm font-medium">
              Destination Location
            </Label>
            <LocationCombobox
              value={m.locationId?.toString() || ""}
              onValueChange={(value) => m.setLocationId(parseInt(value))}
              locations={m.locations}
              placeholder="Select a location"
              testId="select-location"
            />
          </div>

          {/* Calculation Summary */}
          {(m.totalCharges > 0 || totalBales > 0) && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Summary</p>
              <div className="space-y-1.5 text-sm">
                {m.manualCharges > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Manual Charges</span>
                    <span className="font-medium tabular-nums">{formatUsd(m.manualCharges, 0, 2)}</span>
                  </div>
                )}
                {m.poChargesTotal > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">PO Charges (Freight, Docs, etc.)</span>
                    <span className="font-medium tabular-nums">{formatUsd(m.poChargesTotal, 0, 2)}</span>
                  </div>
                )}
                <div className="flex justify-between font-semibold border-t pt-2 mt-1">
                  <span>Total Charges</span>
                  <span className="tabular-nums" data-testid="text-total-charges">
                    {formatUsd(m.totalCharges, 0, 2)}
                  </span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Total Bales</span>
                  <span className="tabular-nums" data-testid="text-total-bales">
                    {formatNumber(totalBales)}
                  </span>
                </div>
                <div className="flex justify-between font-semibold border-t pt-2 mt-1">
                  <span>Cost Added per Bale</span>
                  <span className="tabular-nums" data-testid="text-cost-per-bale">
                    {formatUsd(m.additionalCostPerBale, 0, 2)}
                  </span>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={m.offloadMutation.isPending}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            {m.recordChanges.allowed && (
              <Button
                type="submit"
                disabled={m.offloadMutation.isPending || !m.locationId}
                data-testid="button-offload"
              >
                {m.offloadMutation.isPending ? "Offloading..." : "Offload Container"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
