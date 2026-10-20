/**
 * "Alter account" dialog of the Accounts Overview page.
 *
 * Split out of AccountsLegacy.tsx unchanged: the same read-only code field,
 * the same account-type and sub-type option lists, the same opening
 * balance/side pair, the same parent-group combobox (which excludes the
 * account itself and is hidden for Group accounts) and the same active toggle.
 */
import { useState } from "react";
import { ArrowLeftRight, Check, ChevronsUpDown, Edit, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { AccountsLegacyModel } from "./useAccountsLegacyModel";
import { FactoryFxAgentWalletCard } from "../factory/factorynetposition/components/FactoryFxAgentWalletCard";
import { todayStr } from "../factory/factorynetposition/utils";

const ACCOUNT_TYPES = [
  "Asset",
  "Liability",
  "Equity",
  "Income",
  "Expense",
  "Bank",
  "Cash",
  "Indirect Expense",
  "Direct Expense",
  "Government Taxes",
  "Loans",
  "Duty Agent",
  "Transporter Agent",
  "Accounts Payable",
  "Profit",
];

const SUB_TYPE_OPTIONS: Record<string, string[]> = {
  Income: ["Direct Income", "Indirect Income"],
  Expense: ["Direct Expense", "Indirect Expense"],
  Liability: [
    "Current Liability",
    "Long-term Liability",
    "Loans Payable",
    "Output Tax",
    "Tax Payable",
    "sp_otw_clearing",
    "sp_cost_clearing",
    "sp_pay_deduction_clearing",
    "sp_payable",
  ],
  Asset: ["Current Asset", "Fixed Asset", "Input Tax", "Tax Receivable"],
};

const SUB_TYPE_PARENTS = ["Income", "Expense", "Liability", "Asset"];

export function EditAccountDialog({ model }: { model: AccountsLegacyModel }) {
  const { editForm, alterSelectedAccount, alterAccountType, updateLedgerMutation, deleteLedgerMutation } = model;
  const [fxAccount, setFxAccount] = useState<{ id: number; name: string } | null>(null);

  return (
    <>
      <Dialog
        open={model.editDialogOpen}
        onOpenChange={(open) => {
          if (!open) model.closeEditAccountDialog();
        }}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit className="h-4 w-4 text-muted-foreground" />
              Edit Account
              {alterSelectedAccount && (
                <span className="text-muted-foreground font-normal text-sm truncate">
                  — {alterSelectedAccount.name}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          {alterSelectedAccount && (
            <Form {...editForm}>
              <form
                onSubmit={editForm.handleSubmit((data) => {
                  updateLedgerMutation.mutate({ id: alterSelectedAccount.accountId, ...data });
                  model.setEditDialogOpen(false);
                })}
                className="space-y-4 mt-1"
                noValidate
              >
                {/* Code — read only */}
                <div className="space-y-1.5">
                  <Label>Account Code</Label>
                  <Input
                    value={alterSelectedAccount.code}
                    readOnly
                    className="bg-muted font-mono text-sm"
                    data-testid="input-alter-code"
                  />
                </div>

                {/* Name */}
                <FormField
                  control={editForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Account Name</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-alter-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Account Type */}
                <FormField
                  control={editForm.control}
                  name="accountType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Account Type</FormLabel>
                      <Select
                        onValueChange={(v) => {
                          field.onChange(v);
                          editForm.setValue("subType", "");
                        }}
                        value={field.value || ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-alter-account-type">
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {ACCOUNT_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Sub Type */}
                {SUB_TYPE_PARENTS.includes(alterAccountType || "") && (
                  <FormField
                    control={editForm.control}
                    name="subType"
                    render={({ field }) => {
                      const opts = SUB_TYPE_OPTIONS[alterAccountType || ""] || [];
                      return (
                        <FormItem>
                          <FormLabel>Sub Type</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value || ""}>
                            <FormControl>
                              <SelectTrigger data-testid="select-alter-sub-type">
                                <SelectValue placeholder="Select sub type (optional)" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {opts.map((t) => (
                                <SelectItem key={t} value={t}>
                                  {t}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      );
                    }}
                  />
                )}

                {/* Opening Balance */}
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={editForm.control}
                    name="openingBalance"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Opening Balance</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="0.01"
                            {...field}
                            value={field.value ?? "0"}
                            data-testid="input-alter-balance"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editForm.control}
                    name="openingBalanceSide"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Balance Side</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value || "Dr"}>
                          <FormControl>
                            <SelectTrigger data-testid="select-alter-balance-side">
                              <SelectValue placeholder="Dr/Cr" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="Dr">Dr (Debit)</SelectItem>
                            <SelectItem value="Cr">Cr (Credit)</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Parent Group */}
                {alterSelectedAccount?.subType !== "Group" && (
                  <FormField
                    control={editForm.control}
                    name="parentId"
                    render={({ field }) => {
                      const filteredGroups = model.groupOptions.filter((g) => g.id !== alterSelectedAccount?.accountId);
                      const selectedGroup = filteredGroups.find((g) => g.id === field.value);
                      return (
                        <FormItem className="flex flex-col">
                          <FormLabel>Parent Group</FormLabel>
                          <Popover open={model.parentGroupOpen} onOpenChange={model.setParentGroupOpen}>
                            <PopoverTrigger asChild>
                              <FormControl>
                                <Button
                                  variant="outline"
                                  role="combobox"
                                  className="w-full justify-between font-normal"
                                  data-testid="select-alter-parent-group"
                                >
                                  <span className="truncate">
                                    {selectedGroup ? selectedGroup.name : "— No group —"}
                                  </span>
                                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                </Button>
                              </FormControl>
                            </PopoverTrigger>
                            <PopoverContent className="w-[300px] p-0">
                              <Command>
                                <CommandInput placeholder="Search groups…" />
                                <CommandEmpty>No groups found.</CommandEmpty>
                                <CommandGroup>
                                  <CommandItem
                                    value="__none__"
                                    onSelect={() => {
                                      field.onChange(null);
                                      model.setParentGroupOpen(false);
                                    }}
                                  >
                                    <Check
                                      className={cn("mr-2 h-4 w-4", field.value == null ? "opacity-100" : "opacity-0")}
                                    />
                                    — No group —
                                  </CommandItem>
                                  {filteredGroups.map((g) => (
                                    <CommandItem
                                      key={g.id}
                                      value={g.name}
                                      onSelect={() => {
                                        field.onChange(g.id);
                                        model.setParentGroupOpen(false);
                                      }}
                                    >
                                      <Check
                                        className={cn(
                                          "mr-2 h-4 w-4",
                                          field.value === g.id ? "opacity-100" : "opacity-0"
                                        )}
                                      />
                                      {g.name}
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </Command>
                            </PopoverContent>
                          </Popover>
                          <FormMessage />
                        </FormItem>
                      );
                    }}
                  />
                )}

                {/* Active toggle */}
                <FormField
                  control={editForm.control}
                  name="active"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                      <div>
                        <FormLabel>Active Status</FormLabel>
                        <p className="text-xs text-muted-foreground mt-0.5">Account is available for new entries</p>
                      </div>
                      <FormControl>
                        <Switch
                          checked={!!field.value}
                          onCheckedChange={field.onChange}
                          data-testid="switch-alter-active"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                {model.appMode === "factory" && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    data-testid="button-manage-account-fx"
                    onClick={() => {
                      setFxAccount({ id: alterSelectedAccount.accountId, name: alterSelectedAccount.name });
                      model.closeEditAccountDialog();
                    }}
                  >
                    <ArrowLeftRight className="mr-2 h-4 w-4" />
                    FX Agent USD / EUR — Convert, Pay, Reverse
                  </Button>
                )}

                <div className="flex justify-between gap-2 pt-1">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => model.setShowDeleteAccountConfirm(true)}
                    disabled={deleteLedgerMutation.isPending}
                    data-testid="button-alter-delete"
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    Delete
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={model.closeEditAccountDialog}
                      data-testid="button-alter-cancel"
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={updateLedgerMutation.isPending}
                      data-testid="button-alter-save"
                    >
                      {updateLedgerMutation.isPending ? "Saving…" : "Save Changes"}
                    </Button>
                  </div>
                </div>
              </form>
            </Form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={fxAccount !== null} onOpenChange={(open) => !open && setFxAccount(null)}>
        <DialogContent
          className="w-[95vw] max-w-5xl max-h-[90dvh] overflow-y-auto"
          data-testid="dialog-account-fx-manager"
        >
          <DialogHeader>
            <DialogTitle>FX agent wallet — {fxAccount?.name}</DialogTitle>
            <DialogDescription>
              Convert this account's USD to EUR, pay USD beneficiaries or reverse an unused conversion. Net Position
              values EUR using the Settings rate.
            </DialogDescription>
          </DialogHeader>
          {fxAccount && <FactoryFxAgentWalletCard asOf={todayStr()} readOnly={false} scopeAccountId={fxAccount.id} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
