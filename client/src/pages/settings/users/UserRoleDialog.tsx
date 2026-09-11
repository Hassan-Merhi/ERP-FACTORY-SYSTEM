import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  insertUserCompanyRoleSchema,
  type Company,
  type LedgerAccount,
  type Location,
  type UserCompanyRole,
} from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const roleAssignmentSchema = insertUserCompanyRoleSchema.refine(
  (data) => {
    if (data.role === "POS" && !data.assignedLocationId) return false;
    return true;
  },
  { message: "POS role requires an assigned location", path: ["assignedLocationId"] }
);
type RoleAssignmentData = z.infer<typeof roleAssignmentSchema>;

interface UserRoleDialogProps {
  open: boolean;
  onClose: () => void;
  userId: string;
  companies: Company[];
  editingRole?: UserCompanyRole | null;
}

export function UserRoleDialog({ open, onClose, userId, companies, editingRole }: UserRoleDialogProps) {
  const { toast } = useToast();
  const [selectedLocationIds, setSelectedLocationIds] = useState<number[]>([]);
  const [locationCashAccounts, setLocationCashAccounts] = useState<Record<number, number | undefined>>({});

  const form = useForm<RoleAssignmentData>({
    resolver: zodResolver(roleAssignmentSchema),
    defaultValues: { userId, companyId: companies[0]?.id || 0, role: "Manager" },
  });

  const selectedRole = form.watch("role");
  const selectedCompanyId = form.watch("companyId");
  const isPOSRole = selectedRole === "POS";
  const isViewOnly = selectedRole === "View Only";

  useEffect(() => {
    if (open) {
      if (editingRole) {
        form.reset({
          userId: editingRole.userId,
          companyId: editingRole.companyId,
          role: editingRole.role as RoleAssignmentData["role"],
          assignedLocationId: editingRole.assignedLocationId,
          posStation: editingRole.posStation,
          canSellNegativeStock: editingRole.canSellNegativeStock ?? false,
          daybookEditDays: editingRole.daybookEditDays ?? 0,
          cashAccountId: editingRole.cashAccountId,
        });
        if (editingRole.role === "POS") {
          fetch(`/api/user-locations/${editingRole.userId}/${editingRole.companyId}`)
            .then((r) => r.json())
            .then((locs) => {
              if (Array.isArray(locs) && locs.length > 0) {
                setSelectedLocationIds(locs.map((l) => l.locationId));
              } else {
                setSelectedLocationIds(editingRole.assignedLocationId ? [editingRole.assignedLocationId] : []);
              }
            })
            .catch(() => {
              setSelectedLocationIds(editingRole.assignedLocationId ? [editingRole.assignedLocationId] : []);
            });
          fetch(`/api/user-location-cash-accounts/${editingRole.userId}/${editingRole.companyId}`)
            .then((r) => r.json())
            .then((mappings) => {
              if (Array.isArray(mappings)) {
                const record: Record<number, number> = {};
                mappings.forEach((m) => {
                  record[m.locationId] = m.cashAccountId;
                });
                setLocationCashAccounts(record);
              }
            })
            .catch(() => {});
        } else {
          setSelectedLocationIds([]);
          setLocationCashAccounts({});
        }
      } else {
        form.reset({ userId, companyId: companies[0]?.id || 0, role: "Manager" });
        setSelectedLocationIds([]);
        setLocationCashAccounts({});
      }
    }
  }, [open, editingRole?.id, editingRole, form, userId, companies]);

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations", { companyId: selectedCompanyId }],
    queryFn: async () => {
      if (!selectedCompanyId) return [];
      const res = await fetch(`/api/locations?companyId=${selectedCompanyId}`);
      if (!res.ok) throw new Error("Failed to fetch locations");
      return res.json();
    },
    enabled: !!selectedCompanyId && open && isPOSRole,
  });

  const { data: roleDialogLedgerAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", { companyId: selectedCompanyId }],
    queryFn: async () => {
      if (!selectedCompanyId) return [];
      const res = await fetch(`/api/ledger-accounts?companyId=${selectedCompanyId}`);
      if (!res.ok) throw new Error("Failed to fetch ledger accounts");
      return res.json();
    },
    enabled: !!selectedCompanyId && open,
  });

  const cashAccounts = roleDialogLedgerAccounts.filter((a) => a.accountType === "Cash");

  const saveMutation = useMutation({
    mutationFn: async (data: RoleAssignmentData) => {
      if (data.role === "POS" && selectedLocationIds.length > 0) {
        const missing = selectedLocationIds.filter((id) => !locationCashAccounts[id]);
        if (missing.length > 0) {
          const locNames = missing.map((id) => {
            const loc = locations.find((l) => l.id === id);
            return loc?.name || `Location #${id}`;
          });
          throw new Error(`Cash account required for: ${locNames.join(", ")}`);
        }
      }

      let result;
      if (editingRole) {
        const res = await apiRequest("PATCH", `/api/user-company-roles/${editingRole.id}`, data);
        result = await res.json();
      } else {
        const res = await apiRequest("POST", "/api/user-company-roles", data);
        result = await res.json();
      }
      if (data.role === "POS" && selectedLocationIds.length > 0) {
        await apiRequest("PUT", `/api/user-locations/${data.userId}/${data.companyId}`, {
          locationIds: selectedLocationIds,
        });
        const mappings = selectedLocationIds
          .filter((id) => locationCashAccounts[id])
          .map((id) => ({ locationId: id, cashAccountId: locationCashAccounts[id] }));
        await apiRequest("PUT", `/api/user-location-cash-accounts/${data.userId}/${data.companyId}`, {
          mappings,
        });
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/users/${userId}/company-roles`] });
      queryClient.invalidateQueries({ queryKey: ["/api/my-locations"] });
      toast({
        title: "Success",
        description: editingRole ? "Role updated" : "Role assigned",
      });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = (data: RoleAssignmentData) => {
    saveMutation.mutate(data);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingRole ? "Edit Role Assignment" : "Add Role Assignment"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4" noValidate>
            <FormField
              control={form.control}
              name="companyId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Company *</FormLabel>
                  <Select onValueChange={(v) => field.onChange(parseInt(v))} value={field.value?.toString() || ""}>
                    <FormControl>
                      <SelectTrigger data-testid="select-role-company">
                        <SelectValue placeholder="Select company" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {companies.map((c) => (
                        <SelectItem key={c.id} value={c.id.toString()}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Role *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-role-type">
                        <SelectValue placeholder="Select role" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="Admin">Admin</SelectItem>
                      <SelectItem value="Owner">Owner</SelectItem>
                      <SelectItem value="Manager">Manager</SelectItem>
                      <SelectItem value="POS">POS</SelectItem>
                      <SelectItem value="Normal User">Normal User</SelectItem>
                      <SelectItem value="View Only">View Only</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {isPOSRole && (
              <>
                <FormField
                  control={form.control}
                  name="assignedLocationId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Assigned Locations *</FormLabel>
                      <div
                        className="border rounded-md p-3 space-y-3 max-h-56 overflow-y-auto"
                        data-testid="select-locations"
                      >
                        {locations.map((loc) => {
                          const isChecked = selectedLocationIds.includes(loc.id);
                          return (
                            <div key={loc.id} className="space-y-1.5">
                              <label
                                className="flex items-center gap-2 cursor-pointer text-sm"
                                data-testid={`checkbox-location-${loc.id}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) => {
                                    const newIds = e.target.checked
                                      ? [...selectedLocationIds, loc.id]
                                      : selectedLocationIds.filter((id) => id !== loc.id);
                                    setSelectedLocationIds(newIds);
                                    field.onChange(newIds.length > 0 ? newIds[0] : undefined);
                                    if (!e.target.checked) {
                                      setLocationCashAccounts((prev) => {
                                        const next = { ...prev };
                                        delete next[loc.id];
                                        return next;
                                      });
                                    }
                                  }}
                                  className="rounded"
                                />
                                <span className="font-medium">{loc.name}</span>
                                <span className="text-muted-foreground">({loc.code})</span>
                              </label>
                              {isChecked && (
                                <div className="pl-6">
                                  <Select
                                    value={locationCashAccounts[loc.id]?.toString() || ""}
                                    onValueChange={(v) =>
                                      setLocationCashAccounts((prev) => ({ ...prev, [loc.id]: parseInt(v) }))
                                    }
                                  >
                                    <SelectTrigger
                                      className="h-8 text-xs"
                                      data-testid={`select-cash-account-loc-${loc.id}`}
                                    >
                                      <SelectValue placeholder="Select cash account *" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {cashAccounts.map((a) => (
                                        <SelectItem key={a.id} value={a.id.toString()}>
                                          {a.name} ({a.code})
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  {!locationCashAccounts[loc.id] && (
                                    <p className="text-xs text-destructive mt-0.5">Cash account required</p>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {selectedLocationIds.length === 0 && (
                        <p className="text-sm text-destructive">At least one location is required for POS roles</p>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="posStation"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>POS Station Number</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min="1"
                          max="6"
                          placeholder="1-6"
                          data-testid="input-pos-station"
                          onChange={(e) => field.onChange(e.target.value ? parseInt(e.target.value) : undefined)}
                          value={field.value || ""}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {isViewOnly && (
              <div className="rounded-md bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 px-3 py-2.5 text-sm text-sky-700 dark:text-sky-300">
                This user can only view data — all create, edit, and delete actions are blocked system-wide.
              </div>
            )}

            {selectedRole !== "Admin" && selectedRole !== "Owner" && selectedRole !== "Developer" && !isViewOnly && (
              <FormField
                control={form.control}
                name="daybookEditDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>POS Daybook Editable Days</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        min="0"
                        placeholder="0 = no editing"
                        data-testid="input-daybook-edit-days"
                        onChange={(e) => field.onChange(e.target.value !== "" ? parseInt(e.target.value) : 0)}
                        value={field.value ?? 0}
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      How many past days this user can edit POS daybook vouchers (0 = cannot edit).
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {!isPOSRole && !isViewOnly && (
              <FormField
                control={form.control}
                name="cashAccountId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cash Account (Optional)</FormLabel>
                    <Select
                      onValueChange={(v) => field.onChange(v ? parseInt(v) : undefined)}
                      value={field.value?.toString() || ""}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-cash-account">
                          <SelectValue placeholder="Select cash account" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {cashAccounts.map((a) => (
                          <SelectItem key={a.id} value={a.id.toString()}>
                            {a.name} ({a.code})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {!isViewOnly && (
              <FormField
                control={form.control}
                name="canSellNegativeStock"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <FormLabel className="cursor-pointer">Allow Selling 0-Stock Items</FormLabel>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Lets this user add items to POS even when stock is at 0
                      </p>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value ?? false}
                        onCheckedChange={field.onChange}
                        data-testid="switch-can-sell-negative-stock"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            )}

            <div className="flex gap-2 justify-end border-t pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={saveMutation.isPending}
                data-testid="button-cancel-role"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saveMutation.isPending} data-testid="button-save-role">
                {saveMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
