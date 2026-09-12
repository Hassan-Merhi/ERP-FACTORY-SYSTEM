/**
 * LedgerAccountForm — extracted sub-component.
 *
 * Extracted from AccountingCreate.tsx during the Phase 4 god-file split.
 */
import type { AccountingForm, AccountingFormSubmit, AccountingFormValues, LedgerAccountOption } from "../types";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { ChevronsUpDown, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useCompany } from "@/contexts/CompanyContext";
import { FormButtons } from "./FormButtons";

export // Ledger Account Form Component
function LedgerAccountForm({
  form,
  onSubmit,
  onCancel,
  isPending,
}: {
  form: AccountingForm;
  onSubmit: AccountingFormSubmit;
  onCancel: () => void;
  isPending: boolean;
}) {
  const { toast: _toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const _modeApiRequest = getApiRequest(appMode);
  const accountType = form.watch("accountType");
  const openingBalance = form.watch("openingBalance");
  // Get available subtypes based on account type
  const getSubTypes = () => {
    switch (accountType) {
      case "Income":
        return ["Direct Income", "Indirect Income"];
      case "Expense":
        return ["Direct Expense", "Indirect Expense"];
      case "Liability":
        return ["Current Liability", "Long-term Liability", "Loans Payable", "Output Tax", "Tax Payable"];
      case "Asset":
        return ["Current Asset", "Fixed Asset", "Input Tax", "Tax Receivable"];
      default:
        return [];
    }
  };

  const subTypes = getSubTypes();

  // Fetch Group accounts for the Parent Group combobox
  const { data: allLedgerAccounts = [] } = useQuery<LedgerAccountOption[]>({
    queryKey: ["/api/ledger-accounts", selectedCompany?.id],
    queryFn: async () => {
      const url = selectedCompany?.id ? `/api/ledger-accounts?companyId=${selectedCompany.id}` : "/api/ledger-accounts";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch accounts");
      return res.json();
    },
    enabled: !!selectedCompany,
  });

  const groupAccounts = allLedgerAccounts.filter((acc) => acc.subType === "Group");
  const [parentGroupOpen, setParentGroupOpen] = useState(false);

  return (
    <Card className="p-4 md:p-6">
      <Form {...form}>
        <form
          noValidate
          onSubmit={form.handleSubmit((data: AccountingFormValues) => onSubmit(data, false))}
          className="space-y-6"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name *</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Sales Revenue" data-testid="input-name" />
                  </FormControl>
                  <FormDescription>Code will be auto-generated from the name</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="accountType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account Type *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value || ""}>
                    <FormControl>
                      <SelectTrigger data-testid="select-account-type">
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="Asset">Asset</SelectItem>
                      <SelectItem value="Liability">Liability</SelectItem>
                      <SelectItem value="Equity">Equity</SelectItem>
                      <SelectItem value="Income">Income</SelectItem>
                      <SelectItem value="Expense">Expense</SelectItem>
                      <SelectItem value="Bank">Bank</SelectItem>
                      <SelectItem value="Cash">Cash</SelectItem>
                      <SelectItem value="Indirect Expense">Indirect Expense</SelectItem>
                      <SelectItem value="Direct Expense">Direct Expense</SelectItem>
                      <SelectItem value="Government Taxes">Government Taxes</SelectItem>
                      <SelectItem value="Loans">Loans</SelectItem>
                      <SelectItem value="Duty Agent">Duty Agent</SelectItem>
                      <SelectItem value="Transporter Agent">Transporter Agent</SelectItem>
                      <SelectItem value="Accounts Payable">Accounts Payable</SelectItem>
                      <SelectItem value="Profit">Profit</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {subTypes.length > 0 && (
              <FormField
                control={form.control}
                name="subType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sub Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ""}>
                      <FormControl>
                        <SelectTrigger data-testid="select-sub-type">
                          <SelectValue placeholder="Select sub type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {subTypes.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="parentId"
              render={({ field }) => {
                const selectedGroup = groupAccounts.find((g) => g.id === field.value);
                return (
                  <FormItem className="flex flex-col">
                    <FormLabel>Parent Group</FormLabel>
                    <Popover open={parentGroupOpen} onOpenChange={setParentGroupOpen}>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            role="combobox"
                            className="w-full justify-between font-normal"
                            data-testid="select-parent"
                          >
                            <span className="truncate">{selectedGroup ? selectedGroup.name : "— No group —"}</span>
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
                                field.onChange(undefined);
                                setParentGroupOpen(false);
                              }}
                            >
                              <Check
                                className={cn("mr-2 h-4 w-4", field.value == null ? "opacity-100" : "opacity-0")}
                              />
                              — No group —
                            </CommandItem>
                            {groupAccounts.map((g) => (
                              <CommandItem
                                key={g.id}
                                value={g.name}
                                onSelect={() => {
                                  field.onChange(g.id);
                                  setParentGroupOpen(false);
                                }}
                              >
                                <Check
                                  className={cn("mr-2 h-4 w-4", field.value === g.id ? "opacity-100" : "opacity-0")}
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

            <FormField
              control={form.control}
              name="openingBalance"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Opening Balance</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      data-testid="input-opening-balance"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {openingBalance && parseFloat(openingBalance) !== 0 && (
              <FormField
                control={form.control}
                name="openingBalanceSide"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Dr/Cr Side</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ""}>
                      <FormControl>
                        <SelectTrigger data-testid="select-balance-side">
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="Dr">Debit (Dr)</SelectItem>
                        <SelectItem value="Cr">Credit (Cr)</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2 space-y-0 pt-8">
                  <FormControl>
                    <Checkbox checked={field.value} onCheckedChange={field.onChange} data-testid="checkbox-active" />
                  </FormControl>
                  <FormLabel className="!mt-0">Active</FormLabel>
                </FormItem>
              )}
            />
          </div>

          <FormButtons onCancel={onCancel} isPending={isPending} />
        </form>
      </Form>
    </Card>
  );
}

// Employee Form Component
