import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
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
    queryKey: ["retail-pos-customers", search],
    queryFn: () => searchRetailCustomers(search),
    enabled: open,
    staleTime: 15_000,
  });

  const createMutation = useMutation({
    mutationFn: () => createRetailCustomer({ legalName: newName.trim(), phone: newPhone.trim() || undefined }),
    onSuccess: (created) => {
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
        </div>
        <Button size="sm" variant="ghost" onClick={() => onSelect(null)} data-testid="retail-pos-customer-clear">
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
          data-testid="retail-pos-customer-open"
        >
          <Search className="mr-1 h-3.5 w-3.5" /> Add customer
        </Button>
      </div>
      {open && (
        <div className="space-y-2 rounded-lg border p-2">
          <Input
            autoFocus
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search name, phone or code"
            data-testid="retail-pos-customer-search"
          />
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {(customersQuery.data ?? []).map((entry: Customer) => (
              <button
                key={entry.id}
                type="button"
                className="flex w-full items-center justify-between rounded border px-2 py-1.5 text-left text-sm hover:bg-muted/50"
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
            {customersQuery.isLoading && <div className="p-2 text-xs text-muted-foreground">Searching…</div>}
            {!customersQuery.isLoading && !(customersQuery.data ?? []).length && (
              <div className="p-2 text-xs text-muted-foreground">No customer matches.</div>
            )}
          </div>
          {creating ? (
            <div className="space-y-2 rounded border bg-muted/20 p-2">
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
                <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
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
