import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Textarea } from "@/components/ui/textarea";
import { User, ChevronDown, Check, Save } from "lucide-react";
import type { AuthMe, FactoryMyAccess, ApiListRow } from "@shared/apiTypes";

export interface CheckoutSidebarProps {
  posUser?: AuthMe;
  paymentAccountType: "bank" | "cash" | "credit";
  setPaymentAccountType: (value: "bank" | "cash") => void;
  paymentAccountId: string | null;
  setPaymentAccountId: (id: string | null) => void;
  isCreditSale: boolean;
  setIsCreditSale: (value: boolean) => void;
  selectedCustomerId: string;
  setSelectedCustomerId: (id: string) => void;
  customerComboOpen: boolean;
  setCustomerComboOpen: (open: boolean) => void;
  customerAccounts: any[];
  selectedCustomer: any;
  formatAmountRaw: (amount: string | number) => string;
  bankAccounts: any[];
  cashLedgerAccounts: any[];
  saveMutation: any;
  hasValidItems: boolean;
  editVoucherId?: string;
  handleSaveSale: () => void;
  notes: string;
  setNotes: (notes: string) => void;
  saleDate: string;
  setSaleDate: (date: string) => void;
  total: number;
  totalQty: number;
  rows: any[];
  activeCurrency: string;
  exchangeRate: number;
  formatDisplayAmount: (amount: number) => string;
  cn: (...args: any[]) => string;
}

export function CheckoutSidebar({
  posUser,
  paymentAccountType,
  setPaymentAccountType,
  paymentAccountId,
  setPaymentAccountId,
  isCreditSale,
  setIsCreditSale,
  selectedCustomerId,
  setSelectedCustomerId,
  customerComboOpen,
  setCustomerComboOpen,
  customerAccounts,
  selectedCustomer,
  formatAmountRaw,
  bankAccounts,
  cashLedgerAccounts,
  saveMutation,
  hasValidItems,
  editVoucherId,
  handleSaveSale,
  notes,
  setNotes,
  saleDate,
  setSaleDate,
  total,
  totalQty,
  rows,
  activeCurrency,
  exchangeRate,
  formatDisplayAmount,
  cn,
}: CheckoutSidebarProps) {
  const lockedCashAccount =
    posUser && paymentAccountId ? cashLedgerAccounts.find((a) => String(a.id) === paymentAccountId) : null;
  return (
    <div className="w-full lg:w-80 flex flex-col gap-4">
      <div className="bg-muted/10 p-4 rounded-lg border border-muted/50 space-y-4">
        <div className="flex flex-col items-end border-b border-muted pb-4 mb-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Grand Total</span>
          <span className="text-3xl font-black font-mono tracking-tighter text-primary" data-testid="text-grand-total">
            {formatDisplayAmount(total)}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Items</span>
            <span className="text-lg font-bold font-mono" data-testid="text-item-count">
              {rows.filter((r) => r.amount > 0).length}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Total Qty</span>
            <span className="text-lg font-bold font-mono" data-testid="text-total-qty">
              {totalQty.toFixed(2)}
            </span>
          </div>
        </div>

        {(() => {
          const totalPLUSD = rows.reduce((sum, row) => {
            if (!row.stockItemId || !(row.configuredPrice ?? 0)) return sum;
            return sum + (row.rateUSD - (row.configuredPrice ?? 0)) * row.quantity;
          }, 0);
          const totalPLDisplay = activeCurrency === "CFA" && exchangeRate ? totalPLUSD * exchangeRate : totalPLUSD;
          const anyConfig = rows.some((r) => r.stockItemId && (r.configuredPrice ?? 0) > 0);
          if (!anyConfig) return null;
          return (
            <div className="flex flex-col pt-2 border-t border-muted/50">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Total P/L</span>
              <span
                className={cn(
                  "text-lg font-bold font-mono",
                  totalPLDisplay > 0 ? "text-green-600" : totalPLDisplay < 0 ? "text-red-600" : ""
                )}
                data-testid="text-total-pl"
              >
                {formatDisplayAmount(totalPLDisplay)}
              </span>
            </div>
          );
        })()}
      </div>

      <div className="flex flex-col gap-4 p-1">
        <div className="flex flex-col gap-2">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</Label>
          {posUser ? (
            <div
              className="h-9 flex items-center px-3 rounded-md border border-muted bg-muted/30 text-sm font-mono text-muted-foreground"
              data-testid="text-sale-date"
            >
              {saleDate}
            </div>
          ) : (
            <input
              type="date"
              value={saleDate}
              onChange={(e) => setSaleDate(e.target.value)}
              className="h-9 px-3 rounded-md border border-input bg-background text-sm font-mono w-full focus:outline-none focus:ring-2 focus:ring-ring"
              data-testid="input-sale-date"
            />
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Payment Account</Label>
          {posUser ? (
            <div className="flex items-center gap-2">
              <div
                className="h-9 flex items-center px-3 rounded-md border border-muted bg-muted/30 text-sm text-muted-foreground w-24"
                data-testid="text-payment-type"
              >
                Cash
              </div>
              <div
                className="h-9 flex items-center px-3 rounded-md border border-muted bg-muted/30 text-sm text-muted-foreground flex-1 truncate"
                data-testid="text-payment-account"
              >
                {lockedCashAccount ? lockedCashAccount.name : "—"}
              </div>
            </div>
          ) : (
            !isCreditSale && (
              <div className="flex gap-2">
                <Select
                  value={paymentAccountType}
                  onValueChange={(value: "bank" | "cash") => setPaymentAccountType(value)}
                >
                  <SelectTrigger className="w-24 h-9" data-testid="select-account-type">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank">Bank</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={paymentAccountId || ""} onValueChange={setPaymentAccountId}>
                  <SelectTrigger className="flex-1 h-9" data-testid="select-payment-account">
                    <SelectValue placeholder={paymentAccountType === "bank" ? "Select Bank" : "Select Cash"} />
                  </SelectTrigger>
                  <SelectContent>
                    {paymentAccountType === "bank"
                      ? (Array.isArray(bankAccounts) ? bankAccounts : []).map((acc) => (
                          <SelectItem key={acc.id} value={String(acc.id)}>
                            {acc.name} ({acc.code})
                          </SelectItem>
                        ))
                      : cashLedgerAccounts.map((acc) => (
                          <SelectItem key={acc.id} value={String(acc.id)}>
                            {acc.name} ({acc.code})
                          </SelectItem>
                        ))}
                  </SelectContent>
                </Select>
              </div>
            )
          )}

          {!posUser && (
            <div className="flex items-center gap-2 mt-1">
              <Switch
                id="credit-sale"
                checked={isCreditSale}
                onCheckedChange={setIsCreditSale}
                data-testid="toggle-credit-sale"
              />
              <Label htmlFor="credit-sale" className="text-sm cursor-pointer">
                Credit Sale
              </Label>
            </div>
          )}

          {isCreditSale && (
            <div className="flex flex-col gap-2 mt-1">
              <Popover open={customerComboOpen} onOpenChange={setCustomerComboOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-between font-normal h-9"
                    data-testid="select-customer"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <User className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate">
                        {selectedCustomerId
                          ? customerAccounts.find((a) => String(a.id) === selectedCustomerId)?.name || "Customer"
                          : "Select customer…"}
                      </span>
                    </div>
                    <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-1" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search customer…" data-testid="input-customer-search" />
                    <CommandList>
                      <CommandEmpty>No customer found.</CommandEmpty>
                      <CommandGroup>
                        {customerAccounts.map((acc) => (
                          <CommandItem
                            key={acc.id}
                            value={acc.name}
                            onSelect={() => {
                              setSelectedCustomerId(String(acc.id));
                              setCustomerComboOpen(false);
                            }}
                          >
                            <Check
                              className={`mr-2 h-4 w-4 shrink-0 ${selectedCustomerId === String(acc.id) ? "opacity-100" : "opacity-0"}`}
                            />
                            {acc.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {selectedCustomer && (
                <div className="bg-muted/30 p-2 rounded-md border border-muted/50">
                  <p className="text-xs text-muted-foreground">
                    Current Balance:{" "}
                    <span
                      className={
                        selectedCustomer.balanceSide === "Dr"
                          ? "text-destructive font-semibold"
                          : "text-green-600 dark:text-green-400 font-semibold"
                      }
                    >
                      {formatAmountRaw(selectedCustomer.balance)}{" "}
                      {selectedCustomer.balanceSide === "Dr" ? "owed" : "credit"}
                    </span>
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Notes</Label>
          <Textarea
            placeholder="Sale notes..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="resize-none h-20 min-h-[80px]"
            data-testid="input-notes"
          />
        </div>

        <Button
          className="w-full h-12 text-lg font-bold gap-2 mt-2"
          onClick={handleSaveSale}
          disabled={saveMutation.isPending || !hasValidItems}
          data-testid="button-save-sale"
        >
          {saveMutation.isPending ? (
            "Saving..."
          ) : (
            <>
              <Save className="h-5 w-5" />
              {editVoucherId ? "Update Transaction" : "Save Transaction"}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
