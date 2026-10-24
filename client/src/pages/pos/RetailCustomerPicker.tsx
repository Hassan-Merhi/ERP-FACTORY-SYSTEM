import { useEffect, useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { money } from "./retailPosTypes";
import { createRetailCustomer, searchRetailCustomers } from "./retailWave2Api";
import type { RetailCustomerSummary as Customer } from "./retailWave2Types";

/**
 * Optional customer picker for retail checkout.
 *
 * Walk-in stays the default and costs nothing: the picker only queries when the cashier
 * opens it. Search matches name, phone or code; a customer can be quick-created inline.
 */
export function RetailCustomerPicker({
  customer,
  onSelect,
}: {
  customer: Customer | null;
  onSelect: (customer: Customer | null) => void;
}) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const customerPickerId = useId();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(term.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [term]);

  const customersQuery = useQuery({
    queryKey: ["retail-pos-customers", selectedCompany?.id, search],
    queryFn: () => searchRetailCustomers(search),
    enabled: open && selectedCompany?.companyType === "retail",
    staleTime: 15_000,
  });

  const balanceQuery = useQuery<{ customerId: number; balance: number }>({
    queryKey: ["retail-pos-customer-balance", selectedCompany?.id, customer?.id],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/pos/retail/customers/${customer!.id}/balance`);
      return (await response.json()) as { customerId: number; balance: number };
    },
    enabled: selectedCompany?.companyType === "retail" && Boolean(customer?.id),
    staleTime: 10_000,
  });

  const createMutation = useMutation({
    mutationFn: () => createRetailCustomer({ legalName: newName.trim(), phone: newPhone.trim() || undefined }),
    onSuccess: (created) => {
      // The Retail POS quick-create now also creates the canonical customer
      // ledger. Refresh Accounting -> Parties and Accounts before those pages
      // are revisited, so the new customer and zero opening show immediately.
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/customers/stats", selectedCompany?.id] }),
        queryClient.invalidateQueries({ queryKey: ["/api/customers", selectedCompany?.id] }),
        queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts", selectedCompany?.id] }),
        queryClient.invalidateQueries({ queryKey: ["/api/accounts/all", selectedCompany?.id] }),
        queryClient.invalidateQueries({ queryKey: ["/api/pos/customers"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-pos-customers", selectedCompany?.id] }),
      ]);
      onSelect(created);
      setCreating(false);
      setNewName("");
      setNewPhone("");
      setTerm("");
      setOpen(false);
      toast({ title: "Customer created", description: `${created.legalName} (${created.code})` });
    },
    onError: (error) =>
      toast({ title: "Could not create customer", description: error.message, variant: "destructive" }),
  });

  if (customer) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2 text-sm"
        data-testid="retail-pos-customer"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" data-no-translate>
            {customer.legalName}
          </div>
          <div className="truncate text-xs text-muted-foreground" data-no-translate>
            {customer.code}
            {customer.phone ? ` · ${customer.phone}` : ""}
          </div>
          {balanceQuery.data && (
            <div className="text-xs font-medium" data-testid="retail-customer-balance" data-no-translate>
              {balanceQuery.data.balance > 0.005
                ? `Account balance owed: ${money(balanceQuery.data.balance)}`
                : balanceQuery.data.balance < -0.005
                  ? `Customer credit balance: ${money(-balanceQuery.data.balance)}`
                  : "Account balance: 0.00"}
            </div>
          )}
          {balanceQuery.isError && <div className="text-xs text-destructive">Could not load customer balance</div>}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="min-h-11 sm:min-h-8"
          onClick={() => onSelect(null)}
          data-testid="retail-pos-customer-clear"
        >
          <X className="mr-1 h-3.5 w-3.5" /> Walk-in
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground" data-i18n-ui>
          Walk-in customer
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={customerPickerId}
          data-testid="retail-pos-customer-open"
        >
          <Search className="mr-1 h-3.5 w-3.5" /> Add customer
        </Button>
      </div>
      {open && (
        <div
          id={customerPickerId}
          role="region"
          aria-label="Select retail customer"
          className="space-y-2 rounded-lg border p-2"
        >
          <SearchField
            autoFocus
            value={term}
            onValueChange={setTerm}
            placeholder="Search name, phone or code"
            data-testid="retail-pos-customer-search"
          />
          <div
            className="max-h-40 space-y-1 overflow-y-auto"
            role="group"
            aria-label="Customer search results"
            aria-busy={customersQuery.isLoading}
          >
            {(customersQuery.data ?? []).map((entry: Customer) => (
              <button
                key={entry.id}
                type="button"
                className="flex min-h-11 w-full items-center justify-between rounded-sm border px-2 py-1.5 text-start text-sm hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onSelect(entry);
                  setOpen(false);
                  setTerm("");
                }}
                data-testid="retail-pos-customer-option"
              >
                <span className="min-w-0 truncate" data-no-translate>
                  {entry.legalName}
                </span>
                <span className="ml-2 shrink-0 text-xs text-muted-foreground" data-no-translate>
                  {entry.code}
                  {entry.phone ? ` · ${entry.phone}` : ""}
                </span>
              </button>
            ))}
            {customersQuery.isLoading && (
              <div role="status" className="p-2 text-xs text-muted-foreground">
                Searching…
              </div>
            )}
            {customersQuery.isError && (
              <div role="alert" className="flex items-center justify-between gap-2 p-2 text-xs text-destructive">
                Customer search failed.
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void customersQuery.refetch();
                  }}
                >
                  Retry
                </Button>
              </div>
            )}
            {!customersQuery.isLoading && !customersQuery.isError && !(customersQuery.data ?? []).length && (
              <div role="status" className="p-2 text-xs text-muted-foreground">
                No customer matches.
              </div>
            )}
          </div>
          {creating ? (
            <div className="space-y-2 rounded-sm border bg-muted/20 p-2">
              <div>
                <Label htmlFor="retail-new-customer-name">Customer name</Label>
                <Input
                  id="retail-new-customer-name"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  data-testid="retail-pos-customer-name"
                />
              </div>
              <div>
                <Label htmlFor="retail-new-customer-phone">Phone (optional)</Label>
                <Input
                  id="retail-new-customer-phone"
                  value={newPhone}
                  onChange={(event) => setNewPhone(event.target.value)}
                  data-testid="retail-pos-customer-phone"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!newName.trim() || createMutation.isPending}
                  onClick={() => createMutation.mutate()}
                  data-testid="retail-pos-customer-save"
                >
                  {createMutation.isPending ? "Saving…" : "Create customer"}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => setCreating(true)}
              data-testid="retail-pos-customer-create"
            >
              <UserPlus className="mr-1 h-3.5 w-3.5" /> New customer
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
