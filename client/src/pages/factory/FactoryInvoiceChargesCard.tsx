import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./FactoryInvoiceDetail.tsx
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Pencil } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FactoryInvoiceDetailPageModel, FactoryInvoiceView } from "./FactoryInvoiceDetailPageModel";

export function FactoryInvoiceChargesCard({ m, v }: { m: FactoryInvoiceDetailPageModel; v: FactoryInvoiceView }) {
  return (
    <>
      {m.isAdmin &&
        !m.viewWithoutCharges &&
        (v.freightCharges.length > 0 || v.otherCharges.length > 0 || v.isFinalized) && (
          <Card className={`p-4 mb-6${m.hideExportSelling ? " print:hidden" : ""}`}>
            <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
              <h3 className="font-semibold" data-testid="text-charges-header">
                Freight &amp; Charges
              </h3>
              {v.isFinalized && m.canChange && [...v.freightCharges, ...v.otherCharges].some((c) => !c.voucherId) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => m.relinkVouchersMutation.mutate()}
                  disabled={m.relinkVouchersMutation.isPending}
                  data-testid="button-relink-charge-vouchers"
                >
                  {m.relinkVouchersMutation.isPending ? "Linking..." : "Fix Ledger Entries"}
                </Button>
              )}
            </div>
            <div className="space-y-3">
              {[...v.freightCharges, ...v.otherCharges].map((charge, idx) => {
                const linkedAccount = m.ledgerAccounts.find((a) => a.id === charge.ledgerAccountId);
                const isEditingLedger = m.editingChargeLedger === charge.id;
                const isEditingAmount = m.editingChargeAmount === charge.id;
                const canEditAmount = m.canChange && v.isFinalized && !!charge.voucherId;
                return (
                  <div key={charge.id} className="space-y-1" data-testid={`row-charge-${idx}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm">{charge.name}</span>
                      {isEditingAmount ? (
                        <div className="flex items-center gap-1 print:hidden">
                          <Input
                            type="number"
                            className="h-7 w-28 text-xs text-right font-mono"
                            value={m.chargeAmountInput}
                            onChange={(e) => m.setChargeAmountInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                const val = parseFloat(m.chargeAmountInput);
                                if (!isNaN(val) && val >= 0)
                                  m.updateChargeAmountMutation.mutate({ chargeId: charge.id, amount: val });
                              }
                              if (e.key === "Escape") {
                                m.setEditingChargeAmount(null);
                                m.setChargeAmountInput("");
                              }
                            }}
                            autoFocus
                            data-testid={`input-charge-amount-${charge.id}`}
                          />
                          <Button
                            size="sm"
                            variant="default"
                            className="h-7 text-xs px-2"
                            disabled={m.updateChargeAmountMutation.isPending}
                            onClick={() => {
                              const val = parseFloat(m.chargeAmountInput);
                              if (!isNaN(val) && val >= 0)
                                m.updateChargeAmountMutation.mutate({ chargeId: charge.id, amount: val });
                            }}
                            data-testid={`button-save-charge-amount-${charge.id}`}
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs px-2"
                            onClick={() => {
                              m.setEditingChargeAmount(null);
                              m.setChargeAmountInput("");
                            }}
                            data-testid={`button-cancel-charge-amount-${charge.id}`}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-sm" data-testid={`text-charge-amount-${charge.id}`}>
                            {Number(charge.amount || 0).toLocaleString(undefined, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 2,
                            })}
                          </span>
                          {canEditAmount && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 print:hidden"
                              onClick={() => {
                                m.setEditingChargeAmount(charge.id);
                                m.setChargeAmountInput(charge.amount);
                              }}
                              data-testid={`button-edit-charge-amount-${charge.id}`}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                    {isEditingLedger ? (
                      <div className="flex items-center gap-2 print:hidden">
                        <UnifiedAccountPicker
 options={m.ledgerAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
 value={String(charge.ledgerAccountId ?? "")}
 onChange={(val) => m.updateChargeLedgerMutation.mutate({ chargeId: charge.id, ledgerAccountId: val ? parseInt(val) : null })}
 placeholder={"Select ledger account..."}
 testId={`select-charge-ledger-${charge.id}`}
 className={"h-8 text-xs flex-1"}
 />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => m.setEditingChargeLedger(null)}
                          data-testid={`button-cancel-charge-ledger-${charge.id}`}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 print:hidden">
                        {linkedAccount ? (
                          <Badge variant="secondary" className="text-xs">
                            {linkedAccount.name}
                          </Badge>
                        ) : (
                          <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                            No ledger account — not posted
                          </span>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-xs px-2"
                          onClick={() => m.setEditingChargeLedger(charge.id)}
                          disabled={!m.canChange}
                          title={m.recordChanges.reason ?? undefined}
                          data-testid={`button-edit-charge-ledger-${charge.id}`}
                        >
                          <Pencil className="h-3 w-3 mr-1" />
                          Link
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {v.isFinalized && m.canChange && (
              <div className="mt-3 pt-3 border-t print:hidden">
                {m.showAddCharge ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        placeholder="Charge name"
                        value={m.newChargeName}
                        onChange={(e) => m.setNewChargeName(e.target.value)}
                        className="text-sm"
                        data-testid="input-new-charge-name"
                      />
                      <Input
                        type="number"
                        placeholder="Amount"
                        value={m.newChargeAmount}
                        onChange={(e) => m.setNewChargeAmount(e.target.value)}
                        className="text-sm font-mono"
                        data-testid="input-new-charge-amount"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Select value={m.newChargeType} onValueChange={m.setNewChargeType}>
                        <SelectTrigger className="text-sm" data-testid="select-new-charge-type">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="FREIGHT">Freight</SelectItem>
                          <SelectItem value="CLEARANCE">Clearance</SelectItem>
                          <SelectItem value="OTHER">Other</SelectItem>
                        </SelectContent>
                      </Select>
                      <UnifiedAccountPicker
 options={m.ledgerAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
 value={m.newChargeLedgerId}
 onChange={m.setNewChargeLedgerId}
 placeholder={"Ledger account..."}
 testId={"select-new-charge-ledger"}
 className={"text-sm"}
 />
                    </div>
                    <p className="text-xs text-muted-foreground">Saving will immediately post an accounting voucher.</p>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="default"
                        disabled={
                          m.addChargeMutation.isPending ||
                          !m.newChargeName.trim() ||
                          !m.newChargeAmount ||
                          !m.newChargeLedgerId
                        }
                        onClick={() => {
                          const amt = parseFloat(m.newChargeAmount);
                          if (isNaN(amt) || amt <= 0) return;
                          m.addChargeMutation.mutate({
                            name: m.newChargeName.trim(),
                            amount: amt,
                            chargeType: m.newChargeType,
                            ledgerAccountId: m.newChargeLedgerId ? parseInt(m.newChargeLedgerId) : null,
                          });
                        }}
                        data-testid="button-save-new-charge"
                      >
                        {m.addChargeMutation.isPending ? "Saving..." : "Save Charge"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          m.setShowAddCharge(false);
                          m.setNewChargeName("");
                          m.setNewChargeAmount("");
                          m.setNewChargeType("FREIGHT");
                          m.setNewChargeLedgerId("");
                        }}
                        data-testid="button-cancel-new-charge"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs"
                    onClick={() => m.setShowAddCharge(true)}
                    data-testid="button-add-charge"
                  >
                    <Pencil className="h-3 w-3 mr-1" />
                    Add Charge
                  </Button>
                )}
              </div>
            )}
          </Card>
        )}
    </>
  );
}
