import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Check, ChevronsUpDown, SlidersHorizontal, Trash2, X, Tag, Plus, Folder, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { cn } from "@/lib/utils";

export function parseAccountValue(val: string): { type: "ledger" | "supplier"; id: number } | null {
  if (!val) return null;
  if (val.startsWith("SUP:")) return { type: "supplier", id: parseInt(val.slice(4)) };
  const n = parseInt(val);
  return isNaN(n) ? null : { type: "ledger", id: n };
}

interface AccountComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  accounts: { id: number; name: string; code?: string; accountType?: string; subType?: string }[];
  suppliers?: { id: number; name: string }[];
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}

export function AccountCombobox({
  value,
  onValueChange,
  accounts,
  suppliers,
  placeholder = "Select account",
  disabled = false,
  testId,
}: AccountComboboxProps) {
  const [open, setOpen] = useState(false);
  const parsed = parseAccountValue(value);
  const selectedAccount = parsed?.type === "ledger" ? accounts.find((a) => a.id === parsed.id) : null;
  const selectedSupplier = parsed?.type === "supplier" ? (suppliers || []).find((s) => s.id === parsed.id) : null;
  const displayLabel = selectedSupplier ? selectedSupplier.name : selectedAccount ? selectedAccount.name : placeholder;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          disabled={disabled}
          data-testid={testId}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-[20rem] max-w-[calc(100vw-2rem)] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder="Search account, code, type, or supplier..." />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>No account found.</CommandEmpty>
            <CommandGroup heading="All Ledger Accounts">
              {accounts.map((account) => (
                <CommandItem
                  key={`acc-${account.id}`}
                  value={[account.code, account.name, account.accountType, account.subType].filter(Boolean).join(" ")}
                  onSelect={() => {
                    onValueChange(account.id.toString());
                    setOpen(false);
                  }}
                  data-testid={`option-ledger-account-${account.id}`}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4 shrink-0",
                      value === account.id.toString() ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{account.name}</span>
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                    {[account.accountType, account.code].filter(Boolean).join(" · ")}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            {suppliers && suppliers.length > 0 && (
              <CommandGroup heading="Brokers & Suppliers">
                {suppliers.map((s) => (
                  <CommandItem
                    key={`sup-${s.id}`}
                    value={`supplier broker ${s.name}`}
                    onSelect={() => {
                      onValueChange(`SUP:${s.id}`);
                      setOpen(false);
                    }}
                    data-testid={`option-factory-supplier-${s.id}`}
                  >
                    <Check
                      className={cn("mr-2 h-4 w-4 shrink-0", value === `SUP:${s.id}` ? "opacity-100" : "opacity-0")}
                    />
                    <span className="truncate">{s.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function AdjustmentsHistoryCard({ onDeleteRequest }: { onDeleteRequest: (id: number) => void }) {
  const { formatDisplayDate } = useDateFormat();
  const [open, setOpen] = useState(false);
  interface RawStockAdjustmentRow {
    id: number;
    date: string;
    type: string;
    kg: string;
    costPerKg: string | null;
    currencyCode: string | null;
    supplierId: number | null;
    supplierName: string | null;
    materialLabel: string | null;
    notes: string | null;
  }
  const { data: adjustments, isLoading } = useQuery<RawStockAdjustmentRow[]>({
    queryKey: ["/api/factory/raw-stock/adjustments"],
    enabled: open,
  });

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-full text-muted-foreground"
        onClick={() => setOpen(true)}
        data-testid="button-show-adjustments-history"
      >
        <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" />
        Show Manual Stock Adjustments History
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <SlidersHorizontal className="h-4 w-4" />
          Manual Stock Adjustments
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} data-testid="button-hide-adjustments-history">
          <X className="h-3.5 w-3.5 mr-1" />
          Hide
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : adjustments && adjustments.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Material / Supplier</TableHead>
                  <TableHead className="text-right">Qty (kg)</TableHead>
                  <TableHead className="text-right">Cost/kg</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {adjustments.map((adj) => (
                  <TableRow key={adj.id} data-testid={`row-adjustment-${adj.id}`}>
                    <TableCell className="text-sm text-muted-foreground">{formatDisplayDate(adj.date)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={adj.type === "ADD" ? "default" : adj.type === "DEDUCT" ? "destructive" : "secondary"}
                        data-testid={`badge-adj-type-${adj.id}`}
                      >
                        {adj.type === "DEDUCT" ? "DEDUCT" : adj.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {adj.materialLabel || adj.supplierName || `Supplier #${adj.supplierId}`}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {adj.type === "DEDUCT" ? "-" : ""}
                      {parseFloat(adj.kg).toFixed(3)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {(adj.type === "ADD" || adj.type === "DEDUCT") && parseFloat(adj.costPerKg || "0") > 0
                        ? `${adj.currencyCode} ${parseFloat(adj.costPerKg || "0").toFixed(4)}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                      {adj.notes || "—"}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onDeleteRequest(adj.id)}
                        data-testid={`button-delete-adjustment-${adj.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-center text-muted-foreground py-6 text-sm">No manual adjustments recorded yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

interface SupplierCategory {
  id: number;
  name: string;
  displayOrder: number;
}

export function SupplierCategoriesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [newCatName, setNewCatName] = useState("");
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const { data: categories = [] } = useQuery<SupplierCategory[]>({
    queryKey: ["/api/factory/supplier-categories"],
    enabled: open,
  });

  const { data: fullSuppliers = [] } = useQuery<{ id: number; name: string; supplierCategoryId?: number | null }[]>({
    queryKey: ["/api/factory/suppliers"],
    enabled: open,
  });

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch("/api/factory/supplier-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      setNewCatName("");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/supplier-categories"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const res = await fetch(`/api/factory/supplier-categories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/supplier-categories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/factory/supplier-categories/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      setDeletingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/supplier-categories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const assignMutation = useMutation({
    mutationFn: async ({ supplierId, categoryId }: { supplierId: number; categoryId: number | null }) => {
      const res = await fetch(`/api/factory/suppliers/${supplierId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ supplierCategoryId: categoryId }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const catToDelete = deletingId ? categories.find((c) => c.id === deletingId) : null;
  const supplierCountForCat = (catId: number) => fullSuppliers.filter((s) => s.supplierCategoryId === catId).length;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="h-4 w-4" />
              Manage Supplier Categories
            </DialogTitle>
            <DialogDescription>
              Create categories to group your suppliers, then assign each supplier to a category.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium">New Category</label>
              <div className="flex gap-2">
                <Input
                  placeholder="e.g. Cyprus, Australia…"
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newCatName.trim())
                      wrapAdminAction(() => createMutation.mutate(newCatName), "Create Category");
                  }}
                  data-testid="input-new-category-name"
                />
                <Button
                  onClick={() => {
                    if (newCatName.trim()) wrapAdminAction(() => createMutation.mutate(newCatName), "Create Category");
                  }}
                  disabled={!newCatName.trim() || createMutation.isPending}
                  data-testid="button-create-category"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </div>
            </div>

            {categories.length > 0 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Categories</label>
                <div className="border rounded-md divide-y">
                  {categories.map((cat) => (
                    <div key={cat.id} className="flex items-center gap-2 px-3 py-2">
                      <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                      {editingId === cat.id ? (
                        <Input
                          autoFocus
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && editingName.trim())
                              wrapAdminAction(
                                () => renameMutation.mutate({ id: cat.id, name: editingName }),
                                "Rename Category"
                              );
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="h-7 text-sm flex-1"
                          data-testid={`input-rename-category-${cat.id}`}
                        />
                      ) : (
                        <span className="flex-1 text-sm font-medium">{cat.name}</span>
                      )}
                      <span className="text-xs text-muted-foreground shrink-0">
                        {supplierCountForCat(cat.id)} supplier{supplierCountForCat(cat.id) !== 1 ? "s" : ""}
                      </span>
                      {editingId === cat.id ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              if (editingName.trim())
                                wrapAdminAction(
                                  () => renameMutation.mutate({ id: cat.id, name: editingName }),
                                  "Rename Category"
                                );
                            }}
                            data-testid={`button-save-rename-${cat.id}`}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditingId(cat.id);
                              setEditingName(cat.name);
                            }}
                            data-testid={`button-rename-category-${cat.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDeletingId(cat.id)}
                            data-testid={`button-delete-category-${cat.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {fullSuppliers.length > 0 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Assign Suppliers to Categories</label>
                <div className="border rounded-md divide-y">
                  {fullSuppliers.map((sup) => (
                    <div key={sup.id} className="flex items-center gap-3 px-3 py-2">
                      <span className="flex-1 text-sm truncate">{sup.name}</span>
                      <Select
                        value={sup.supplierCategoryId != null ? String(sup.supplierCategoryId) : "none"}
                        onValueChange={(val) => {
                          wrapAdminAction(
                            () =>
                              assignMutation.mutate({
                                supplierId: sup.id,
                                categoryId: val === "none" ? null : parseInt(val),
                              }),
                            "Assign Category"
                          );
                        }}
                      >
                        <SelectTrigger className="h-7 w-40 text-xs" data-testid={`select-supplier-category-${sup.id}`}>
                          <SelectValue placeholder="Uncategorized" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Uncategorized</SelectItem>
                          {categories.map((cat) => (
                            <SelectItem key={cat.id} value={String(cat.id)}>
                              {cat.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <AlertDialog
            open={!!deletingId}
            onOpenChange={(open) => {
              if (!open) setDeletingId(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete category "{catToDelete?.name}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  Suppliers in this category will become uncategorized. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    if (deletingId) wrapAdminAction(() => deleteMutation.mutate(deletingId!), "Delete Category");
                  }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </>
  );
}
