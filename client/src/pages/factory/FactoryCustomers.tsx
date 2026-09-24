import { searchAny } from "@shared/searchNormalization";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { drCrClass } from "@/lib/formatNumber";
import { factoryApiRequest } from "@/lib/factoryApi";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { useLocation } from "wouter";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Pencil, Search, User, Trash2, FileText, RotateCcw, History, Clock, Eye, EyeOff } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { PageHeader } from "@/components/PageHeader";

interface Customer {
  id: number;
  code: string;
  legalName: string;
  phone: string | null;
  openingBalance: string | null;
  openingBalanceSide: string | null;
  active: boolean;
  paymentTermsDays: number | null;
  balance?: number;
  balanceSide?: string;
}

export default function FactoryCustomers() {
  const { toast } = useToast();
  const { formatCashAmount } = useCurrencyContext();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [deletingCustomer, setDeletingCustomer] = useState<Customer | null>(null);
  const [showDeleted, _setShowDeleted] = useState(false);
  const [showZeroBalance, setShowZeroBalance] = useState(false);
  const [formData, setFormData] = useState({
    legalName: "",
    phone: "",
    openingBalance: "",
    openingBalanceSide: "Dr",
    paymentTermsDays: "" as string,
  });

  const {
    data: customers = [],
    isLoading,
    isError,
    error,
  } = useQuery<Customer[]>({
    queryKey: ["/api/factory/customers"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: {
      legalName: string;
      phone?: string;
      openingBalance?: string;
      openingBalanceSide?: string;
      paymentTermsDays?: number;
    }) => {
      return await factoryApiRequest("POST", "/api/factory/customers", data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Customer created" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      setIsCreateOpen(false);
      resetForm();
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: number;
      data: { legalName: string; phone: string | null; paymentTermsDays: number | null };
    }) => {
      return await factoryApiRequest("PUT", `/api/factory/customers/${id}`, data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Customer updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      setEditingCustomer(null);
      resetForm();
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      return await factoryApiRequest("DELETE", `/api/factory/customers/${id}`, {});
    },
    onSuccess: () => {
      toast({ title: "Customer deleted", description: "You can restore them from the deleted customers list." });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers/deleted"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      setDeletingCustomer(null);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const { data: deletedCustomers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/factory/customers/deleted"],
    enabled: showDeleted,
  });

  const restoreMutation = useMutation({
    mutationFn: async (id: number) => {
      return await factoryApiRequest("POST", `/api/factory/customers/${id}/restore`, {});
    },
    onSuccess: () => {
      toast({ title: "Customer restored", description: "The customer is now active again." });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers/deleted"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setFormData({ legalName: "", phone: "", openingBalance: "", openingBalanceSide: "Dr", paymentTermsDays: "" });
  };

  const openCreate = () => {
    resetForm();
    setIsCreateOpen(true);
  };

  const openEdit = (customer: Customer) => {
    setEditingCustomer(customer);
    setFormData({
      legalName: customer.legalName,
      phone: customer.phone || "",
      openingBalance: customer.openingBalance || "",
      openingBalanceSide: customer.openingBalanceSide || "Dr",
      paymentTermsDays: customer.paymentTermsDays != null ? String(customer.paymentTermsDays) : "",
    });
  };

  const handleCreate = () => {
    if (!formData.legalName.trim()) return;
    const days = formData.paymentTermsDays ? parseInt(formData.paymentTermsDays) : undefined;
    createMutation.mutate({
      legalName: formData.legalName.trim(),
      phone: formData.phone.trim() || undefined,
      openingBalance: formData.openingBalance || undefined,
      openingBalanceSide: formData.openingBalanceSide || undefined,
      paymentTermsDays: days || undefined,
    });
  };

  const handleUpdate = () => {
    if (!editingCustomer || !formData.legalName.trim()) return;
    const days = formData.paymentTermsDays ? parseInt(formData.paymentTermsDays) : null;
    updateMutation.mutate({
      id: editingCustomer.id,
      data: {
        legalName: formData.legalName.trim(),
        phone: formData.phone.trim() || null,
        paymentTermsDays: days,
      },
    });
  };

  const filtered = customers.filter((c) => {
    if (!search) return true;
    return searchAny(search, c.legalName, c.code, c.phone);
  });
  const zeroBalanceCount = filtered.filter((customer) => Math.abs(customer.balance ?? 0) <= 0.001).length;
  const visibleCustomers = showZeroBalance
    ? filtered
    : filtered.filter((customer) => Math.abs(customer.balance ?? 0) > 0.001);

  if (isLoading) {
    return (
      <div className="flex flex-col h-full p-6 gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col h-full p-6 gap-4">
        <PageHeader title="Customers" />
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load customers: {error?.message || "Unknown error"}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">
            Customers
          </h1>
          <p className="text-sm text-muted-foreground">{customers.length} total customers</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {zeroBalanceCount > 0 && (
            <Button
              variant="outline"
              onClick={() => setShowZeroBalance((visible) => !visible)}
              aria-pressed={showZeroBalance}
              data-testid="button-toggle-zero-balance"
              size="sm"
              className="h-9 gap-2 rounded-lg px-4"
            >
              {showZeroBalance ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              {showZeroBalance ? "Hide 0 Balance" : `Show 0 Balance (${zeroBalanceCount})`}
            </Button>
          )}
          <Button
            onClick={openCreate}
            data-testid="button-add-customer"
            size="sm"
            className="h-9 gap-2 rounded-lg px-4 shadow-sm"
          >
            <Plus className="h-4 w-4" />
            Add Customer
          </Button>
        </div>
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name, code, or phone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
          data-testid="input-search-customers"
        />
      </div>

      <div className="rounded-xl border overflow-hidden">
        <div className="table-responsive">
          <Table>
            <TableHeader className="sticky top-0 z-30">
              <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
                <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Name
                </TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Balance
                </TableHead>
                <TableHead className="w-[90px] py-2"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleCustomers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                    {search
                      ? "No customers match your search"
                      : zeroBalanceCount > 0
                        ? "All customers currently have a zero balance"
                        : "No customers yet"}
                  </TableCell>
                </TableRow>
              ) : (
                visibleCustomers.map((customer) => (
                  <TableRow key={customer.id} data-testid={`row-customer-${customer.id}`}>
                    <TableCell className="font-medium" data-testid={`text-customer-name-${customer.id}`}>
                      <button
                        className="text-left hover:underline text-foreground"
                        onClick={() => navigate(`/factory/customers/${customer.id}`)}
                        data-testid={`button-open-statement-${customer.id}`}
                      >
                        {customer.legalName}
                      </button>
                      {customer.phone && <p className="text-xs text-muted-foreground mt-0.5">{customer.phone}</p>}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {customer.balance !== undefined ? (
                        <span data-testid={`text-customer-balance-${customer.id}`}>
                          {formatCashAmount(customer.balance)}{" "}
                          <span className={`text-xs font-semibold ${drCrClass(customer.balanceSide)}`}>
                            {customer.balanceSide}
                          </span>
                        </span>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => navigate(`/factory/invoicing?tab=proformas&customerId=${customer.id}`)}
                          title="View Proformas"
                          data-testid={`button-proformas-customer-${customer.id}`}
                        >
                          <FileText className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(customer)}
                          title="Edit Customer"
                          data-testid={`button-edit-customer-${customer.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <div className="w-px h-5 bg-border mx-0.5" />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeletingCustomer(customer)}
                          title="Delete Customer"
                          className="text-destructive"
                          data-testid={`button-delete-customer-${customer.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {showDeleted && (
        <div className="rounded-xl border overflow-hidden mt-6">
          <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
            <History className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Deleted Customers</span>
            {deletedCustomers.length > 0 && (
              <Badge variant="secondary" className="no-default-hover-elevate no-default-active-elevate text-xs">
                {deletedCustomers.length}
              </Badge>
            )}
          </div>
          {deletedCustomers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8 px-4">No deleted customers found</p>
          ) : (
            <div className="table-responsive">
              <Table>
                <TableHeader className="sticky top-0 z-30">
                  <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
                    <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                      Name
                    </TableHead>
                    <TableHead className="w-[80px] py-2"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deletedCustomers.map((customer) => (
                    <TableRow key={customer.id} data-testid={`row-deleted-customer-${customer.id}`}>
                      <TableCell className="font-medium text-muted-foreground">{customer.legalName}</TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => restoreMutation.mutate(customer.id)}
                          disabled={restoreMutation.isPending}
                          data-testid={`button-restore-customer-${customer.id}`}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          Restore
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={isCreateOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCreateOpen(false);
            resetForm();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Add Customer
            </DialogTitle>
            <DialogDescription>A unique customer code will be generated automatically.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Name</label>
              <Input
                value={formData.legalName}
                onChange={(e) => setFormData({ ...formData, legalName: e.target.value })}
                placeholder="Customer name"
                data-testid="input-customer-name"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Phone</label>
              <Input
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="Phone number"
                data-testid="input-customer-phone"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">Opening Balance</label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.openingBalance}
                  onChange={(e) => setFormData({ ...formData, openingBalance: e.target.value })}
                  placeholder="0.00"
                  data-testid="input-customer-opening-balance"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Side</label>
                <Select
                  value={formData.openingBalanceSide}
                  onValueChange={(v) => setFormData({ ...formData, openingBalanceSide: v })}
                >
                  <SelectTrigger data-testid="select-balance-side">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Dr">Debit (Dr)</SelectItem>
                    <SelectItem value="Cr">Credit (Cr)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                Payment Terms
              </label>
              <Select
                value={formData.paymentTermsDays || "none"}
                onValueChange={(v) =>
                  setFormData({ ...formData, paymentTermsDays: v === "none" ? "" : v === "custom" ? "" : v })
                }
              >
                <SelectTrigger data-testid="select-payment-terms">
                  <SelectValue placeholder="No payment terms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No payment terms</SelectItem>
                  <SelectItem value="30">Net 30 days</SelectItem>
                  <SelectItem value="45">Net 45 days</SelectItem>
                  <SelectItem value="60">Net 60 days</SelectItem>
                  <SelectItem value="90">Net 90 days</SelectItem>
                </SelectContent>
              </Select>
              {formData.paymentTermsDays && !["30", "45", "60", "90"].includes(formData.paymentTermsDays) && (
                <Input
                  type="number"
                  min={1}
                  value={formData.paymentTermsDays}
                  onChange={(e) => setFormData({ ...formData, paymentTermsDays: e.target.value })}
                  placeholder="Days"
                  className="mt-2"
                  data-testid="input-custom-payment-terms"
                />
              )}
              <p className="text-xs text-muted-foreground mt-1">
                A WhatsApp reminder will be sent when this customer has an outstanding balance past their due date.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setIsCreateOpen(false);
                  resetForm();
                }}
                data-testid="button-cancel-create"
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={createMutation.isPending || !formData.legalName.trim()}
                data-testid="button-submit-customer"
              >
                {createMutation.isPending ? "Creating..." : "Create Customer"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editingCustomer}
        onOpenChange={(open) => {
          if (!open) {
            setEditingCustomer(null);
            resetForm();
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              Edit Customer
            </DialogTitle>
            <DialogDescription>{editingCustomer ? `Editing ${editingCustomer.legalName}` : ""}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Name</label>
              <Input
                value={formData.legalName}
                onChange={(e) => setFormData({ ...formData, legalName: e.target.value })}
                placeholder="Customer name"
                data-testid="input-edit-customer-name"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Phone</label>
              <Input
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="Phone number"
                data-testid="input-edit-customer-phone"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                Payment Terms
              </label>
              <Select
                value={
                  formData.paymentTermsDays && ["30", "45", "60", "90"].includes(formData.paymentTermsDays)
                    ? formData.paymentTermsDays
                    : formData.paymentTermsDays
                      ? "custom"
                      : "none"
                }
                onValueChange={(v) => {
                  if (v === "none") setFormData({ ...formData, paymentTermsDays: "" });
                  else if (v === "custom") setFormData({ ...formData, paymentTermsDays: "" });
                  else setFormData({ ...formData, paymentTermsDays: v });
                }}
              >
                <SelectTrigger data-testid="select-edit-payment-terms">
                  <SelectValue placeholder="No payment terms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No payment terms</SelectItem>
                  <SelectItem value="30">Net 30 days</SelectItem>
                  <SelectItem value="45">Net 45 days</SelectItem>
                  <SelectItem value="60">Net 60 days</SelectItem>
                  <SelectItem value="90">Net 90 days</SelectItem>
                  <SelectItem value="custom">Custom...</SelectItem>
                </SelectContent>
              </Select>
              {formData.paymentTermsDays && !["30", "45", "60", "90"].includes(formData.paymentTermsDays) && (
                <Input
                  type="number"
                  min={1}
                  value={formData.paymentTermsDays}
                  onChange={(e) => setFormData({ ...formData, paymentTermsDays: e.target.value })}
                  placeholder="Number of days"
                  className="mt-2"
                  data-testid="input-edit-custom-payment-terms"
                />
              )}
              <p className="text-xs text-muted-foreground mt-1">
                A WhatsApp reminder is sent at 9 AM when this customer has an outstanding balance past their due date.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  setEditingCustomer(null);
                  resetForm();
                }}
                data-testid="button-cancel-edit"
              >
                Cancel
              </Button>
              <Button
                onClick={handleUpdate}
                disabled={updateMutation.isPending || !formData.legalName.trim()}
                data-testid="button-submit-edit-customer"
              >
                {updateMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deletingCustomer}
        onOpenChange={(open) => {
          if (!open) setDeletingCustomer(null);
        }}
        title="Delete Customer"
        tone="destructive"
        confirmText={deleteMutation.isPending ? "Deleting..." : "Delete"}
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (deletingCustomer) deleteMutation.mutate(deletingCustomer.id);
        }}
        description={
          <span>
            Are you sure you want to delete <strong>{deletingCustomer?.legalName}</strong>? They will be hidden from the
            customers list. You can restore them later from the "Deleted Customers" section.
          </span>
        }
      />
    </div>
  );
}
