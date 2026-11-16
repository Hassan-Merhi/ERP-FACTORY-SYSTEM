// Extracted from ./PropertiesDashboard.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ArrowDownLeft, ArrowUpRight, Check, ChevronsUpDown, GripVertical, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePropertiesDashboardState } from "./usePropertiesDashboardState";

export function PropertiesDashboardSection({
  addAccountMutation,
  addPayableAccountMutation,
  allAccounts,
  availableCashAccounts,
  availablePayableAccounts,
  canConfigureDashboard,
  cashAccountsError,
  cashComboboxOpen,
  dashboardPayableAccounts,
  displayedCashAccounts,
  dragCashRef,
  dragPayableRef,
  formatAmount,
  handleCashDrop,
  handlePayableDrop,
  isAddDialogOpen,
  isAddPayableDialogOpen,
  payableAccountsError,
  payableComboboxOpen,
  removeAccountMutation,
  removePayableAccountMutation,
  selectedAccountId,
  selectedPayableAccountId,
  setCashComboboxOpen,
  setIsAddDialogOpen,
  setIsAddPayableDialogOpen,
  setPayableComboboxOpen,
  setSelectedAccountId,
  setSelectedPayableAccountId,
}: Pick<
  ReturnType<typeof usePropertiesDashboardState>,
  | "addAccountMutation"
  | "addPayableAccountMutation"
  | "allAccounts"
  | "availableCashAccounts"
  | "availablePayableAccounts"
  | "canConfigureDashboard"
  | "cashAccountsError"
  | "cashComboboxOpen"
  | "dashboardPayableAccounts"
  | "displayedCashAccounts"
  | "dragCashRef"
  | "dragPayableRef"
  | "formatAmount"
  | "handleCashDrop"
  | "handlePayableDrop"
  | "isAddDialogOpen"
  | "isAddPayableDialogOpen"
  | "payableAccountsError"
  | "payableComboboxOpen"
  | "removeAccountMutation"
  | "removePayableAccountMutation"
  | "selectedAccountId"
  | "selectedPayableAccountId"
  | "setCashComboboxOpen"
  | "setIsAddDialogOpen"
  | "setIsAddPayableDialogOpen"
  | "setPayableComboboxOpen"
  | "setSelectedAccountId"
  | "setSelectedPayableAccountId"
>) {
  return (
    <div className="p-4 sm:p-6 space-y-4">
      {/* Available section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-green-600 flex items-center gap-1.5">
            <ArrowDownLeft className="h-4 w-4" />
            Available
          </h3>
          {canConfigureDashboard && (
            <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline" data-testid="button-add-cash-account">
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Account to Available</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium mb-2 block">Account</label>
                    <Popover open={cashComboboxOpen} onOpenChange={setCashComboboxOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={cashComboboxOpen}
                          className="w-full justify-between"
                          data-testid="select-account"
                        >
                          {selectedAccountId > 0
                            ? availableCashAccounts.find((acc) => acc.accountId === selectedAccountId)?.name ||
                              "Select account..."
                            : "Search accounts..."}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-full p-0" align="start">
                        <Command>
                          <CommandInput placeholder="Search accounts..." />
                          <CommandList>
                            <CommandEmpty>No account found.</CommandEmpty>
                            <CommandGroup>
                              {availableCashAccounts.map((account) => (
                                <CommandItem
                                  key={account.id}
                                  value={account.name}
                                  onSelect={() => {
                                    setSelectedAccountId(account.accountId);
                                    setCashComboboxOpen(false);
                                  }}
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 h-4 w-4",
                                      selectedAccountId === account.accountId ? "opacity-100" : "opacity-0"
                                    )}
                                  />
                                  {account.name}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <Button
                    onClick={() => {
                      if (selectedAccountId > 0) {
                        const account = allAccounts.find((a) => a.accountId === selectedAccountId);
                        addAccountMutation.mutate({
                          accountType: account?.type.toLowerCase() || "ledger",
                          accountId: selectedAccountId,
                        });
                      }
                    }}
                    disabled={selectedAccountId === 0 || addAccountMutation.isPending}
                    className="w-full"
                    data-testid="button-save-cash-account"
                  >
                    {addAccountMutation.isPending ? "Adding..." : "Add Account"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>

        {cashAccountsError ? (
          <p className="text-sm text-destructive text-center py-4">
            Error loading accounts: {cashAccountsError?.message || "Unknown error"}
          </p>
        ) : displayedCashAccounts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No accounts added yet</p>
        ) : (
          <div className="space-y-1">
            {displayedCashAccounts.map((dca) => {
              const balance = parseFloat(String(dca.account.balance || dca.account.currentBalance || 0));
              return (
                <div
                  key={dca.id}
                  draggable={canConfigureDashboard}
                  onDragStart={() => {
                    dragCashRef.current = dca.id;
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleCashDrop(dca.id)}
                  className="flex items-center gap-2 py-2 px-2 rounded-sm hover-elevate group cursor-grab active:cursor-grabbing"
                  data-testid={`cash-account-row-${dca.id}`}
                >
                  <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                  <span className="flex-1 text-sm font-medium truncate">{dca.account.name}</span>
                  <span className="text-sm font-bold font-mono text-green-600" data-testid={`text-balance-${dca.id}`}>
                    {formatAmount(balance)}
                  </span>
                  {canConfigureDashboard && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="ml-1 opacity-100 md:opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity shrink-0"
                      onClick={() => removeAccountMutation.mutate(dca.id)}
                      data-testid={`button-remove-cash-account-${dca.id}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              );
            })}
            <div className="flex items-center justify-between py-2 px-2 bg-green-50 dark:bg-green-950/30 rounded-sm font-bold mt-1">
              <span className="text-sm">Total Available</span>
              <span className="text-sm font-mono text-green-600">
                {formatAmount(
                  displayedCashAccounts.reduce(
                    (s, d) => s + parseFloat(String(d.account.balance || d.account.currentBalance || 0)),
                    0
                  )
                )}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="border-t" />

      {/* To Pay section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-red-600 flex items-center gap-1.5">
            <ArrowUpRight className="h-4 w-4" />
            To Pay
          </h3>
          {canConfigureDashboard && (
            <Dialog open={isAddPayableDialogOpen} onOpenChange={setIsAddPayableDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline" data-testid="button-add-payable-account">
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Account to To Pay</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium mb-2 block">Account</label>
                    <Popover open={payableComboboxOpen} onOpenChange={setPayableComboboxOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={payableComboboxOpen}
                          className="w-full justify-between"
                          data-testid="select-payable-account"
                        >
                          {selectedPayableAccountId > 0
                            ? availablePayableAccounts.find((acc) => acc.accountId === selectedPayableAccountId)
                                ?.name || "Select account..."
                            : "Search accounts..."}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-full p-0" align="start">
                        <Command>
                          <CommandInput placeholder="Search accounts..." />
                          <CommandList>
                            <CommandEmpty>No account found.</CommandEmpty>
                            <CommandGroup>
                              {availablePayableAccounts.map((account) => (
                                <CommandItem
                                  key={account.accountId}
                                  value={account.name}
                                  onSelect={() => {
                                    setSelectedPayableAccountId(account.accountId);
                                    setPayableComboboxOpen(false);
                                  }}
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 h-4 w-4",
                                      selectedPayableAccountId === account.accountId ? "opacity-100" : "opacity-0"
                                    )}
                                  />
                                  {account.name}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <Button
                    onClick={() => {
                      if (selectedPayableAccountId > 0) {
                        addPayableAccountMutation.mutate({ accountId: selectedPayableAccountId });
                      }
                    }}
                    disabled={selectedPayableAccountId === 0 || addPayableAccountMutation.isPending}
                    className="w-full"
                    data-testid="button-save-payable-account"
                  >
                    {addPayableAccountMutation.isPending ? "Adding..." : "Add Account"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>

        {payableAccountsError ? (
          <p className="text-sm text-destructive text-center py-4">
            Error loading accounts: {payableAccountsError?.message || "Unknown error"}
          </p>
        ) : dashboardPayableAccounts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No accounts added yet</p>
        ) : (
          <div className="space-y-1">
            {dashboardPayableAccounts.map((account) => (
              <div
                key={account.id}
                draggable={canConfigureDashboard}
                onDragStart={() => {
                  dragPayableRef.current = account.id;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handlePayableDrop(account.id)}
                className="flex items-center gap-2 py-2 px-2 rounded-sm hover-elevate group cursor-grab active:cursor-grabbing"
                data-testid={`payable-account-row-${account.id}`}
              >
                <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                <span className="flex-1 text-sm font-medium truncate">{account.name}</span>
                <span className="text-sm font-bold font-mono text-red-600" data-testid={`text-payable-${account.id}`}>
                  {formatAmount(Math.abs(account.balance))}
                </span>
                {canConfigureDashboard && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-1 opacity-100 md:opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity shrink-0"
                    onClick={() => removePayableAccountMutation.mutate(account.id)}
                    data-testid={`button-remove-payable-account-${account.id}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between py-2 px-2 bg-red-50 dark:bg-red-950/30 rounded-sm font-bold mt-1">
              <span className="text-sm">Total To Pay</span>
              <span className="text-sm font-mono text-red-600">
                {formatAmount(dashboardPayableAccounts.reduce((s, a) => s + Math.abs(a.balance), 0))}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
