import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { usePasswordConfirmedAction } from "@/hooks/use-password-confirmed-action";
import { Users, Plus, Pencil, Shield, Check, X, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { FACTORY_SETTINGS_PAGES } from "@/app/factoryAccessRegistry";

interface FactoryUser {
  id: string;
  username: string;
  active: boolean;
  displayName: string | null;
  pageAccess: string[];
  hasErpAccess: boolean;
  hasFactoryAccess: boolean;
  hiddenCostFields: string[];
  hideAllCosts: boolean;
  createdAt: string;
  role?: string;
}

const COST_FIELDS: { key: string; label: string }[] = [
  { key: "inventory_avg_rate", label: "Location Inventory: Avg Rate" },
  { key: "inventory_total_value", label: "Location Inventory: Total Value" },
  { key: "inventory_sell_price", label: "Location Inventory: Sell Price" },
  { key: "inventory_sell_value", label: "Location Inventory: Sell Value" },
  { key: "bale_history_cost_per_kg", label: "Bale History: Cost/KG" },
  { key: "bale_history_total_cost", label: "Bale History: Total Cost" },
  { key: "bales_list_cost_per_kg", label: "Bales List: Cost/kg" },
  { key: "production_comparison_costing", label: "Production Comparison: Costing & Profit" },
];

// Central source of truth from FactorySidebar — no separate hardcoded list
const ALL_FACTORY_PAGES = FACTORY_SETTINGS_PAGES;
const PAGE_GROUPS = Array.from(new Set(ALL_FACTORY_PAGES.map((p) => p.group)));

export default function FactoryUsers() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { requestPasswordConfirmation, PasswordConfirmationDialog } = usePasswordConfirmedAction();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<FactoryUser | null>(null);
  const [deletingUser, setDeletingUser] = useState<FactoryUser | null>(null);
  const [formData, setFormData] = useState({
    username: "",
    password: "",
    displayName: "",
    hasErpAccess: true,
    hasFactoryAccess: true,
  });
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [hiddenCostFields, setHiddenCostFields] = useState<string[]>([]);
  const [hideAllCosts, setHideAllCosts] = useState(false);
  const { toast } = useToast();

  const { data: factoryUsers, isLoading } = useQuery<FactoryUser[]>({
    queryKey: ["/api/factory/users"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: {
      username: string;
      password: string;
      displayName: string;
      pageAccess: string[];
      hasErpAccess: boolean;
      hasFactoryAccess: boolean;
      hiddenCostFields: string[];
      hideAllCosts?: boolean;
    }) => {
      const res = await factoryApiRequest("POST", "/api/factory/users", data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to create user");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/users"] });
      toast({ title: "Created", description: "User created successfully" });
      resetForm();
      setCreateOpen(false);
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      userId,
      data,
    }: {
      userId: string;
      data: {
        username: string | undefined;
        displayName: string;
        pageAccess: string[];
        password: string | undefined;
        hasErpAccess: boolean;
        hasFactoryAccess: boolean;
        hiddenCostFields: string[];
        hideAllCosts: boolean;
      };
    }) => {
      const res = await factoryApiRequest("PUT", `/api/factory/users/${userId}`, data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update user");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/users"] });
      toast({ title: "Updated", description: "User access updated" });
      resetForm();
      setEditingUser(null);
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setFormData({
      username: "",
      password: "",
      displayName: "",
      hasErpAccess: true,
      hasFactoryAccess: true,
    });
    setSelectedPages(new Set());
    setHiddenCostFields([]);
    setHideAllCosts(false);
  };

  const openEdit = (user: FactoryUser) => {
    setEditingUser(user);
    setFormData({
      username: user.username,
      password: "",
      displayName: user.displayName || "",
      hasErpAccess: user.hasErpAccess ?? true,
      hasFactoryAccess: user.hasFactoryAccess ?? true,
    });
    setSelectedPages(new Set(user.pageAccess));
    setHiddenCostFields(user.hiddenCostFields ?? []);
    setHideAllCosts(user.hideAllCosts ?? false);
  };

  const toggleCostField = (key: string) => {
    setHiddenCostFields((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const isAdminOrOwner = (user: FactoryUser) => {
    const role = user.role?.toLowerCase();
    return role === "admin" || role === "owner" || role === "developer";
  };

  const toggleAccessMutation = useMutation({
    mutationFn: async ({
      userId,
      data,
    }: {
      userId: string;
      data: { hasErpAccess?: boolean; hasFactoryAccess?: boolean };
    }) => {
      const res = await factoryApiRequest("PUT", `/api/factory/users/${userId}`, data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update access");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/users"] });
      toast({ title: "Updated", description: "Access updated successfully" });
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await factoryApiRequest("DELETE", `/api/factory/users/${userId}`, {});
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to remove user");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/users"] });
      toast({ title: "User removed", description: "User has been removed from this company" });
      setDeletingUser(null);
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    if (editingUser) {
      const isPrivileged = isAdminOrOwner(editingUser);
      wrapAdminAction(
        () =>
          requestPasswordConfirmation(
            () =>
              updateMutation.mutate({
                userId: editingUser.id,
                data: {
                  username: formData.username !== editingUser.username ? formData.username : undefined,
                  displayName: formData.displayName,
                  pageAccess: Array.from(selectedPages),
                  password: formData.password || undefined,
                  hasErpAccess: isPrivileged ? true : formData.hasErpAccess,
                  hasFactoryAccess: isPrivileged ? true : formData.hasFactoryAccess,
                  hiddenCostFields: isPrivileged ? [] : hiddenCostFields,
                  hideAllCosts: isPrivileged ? false : hideAllCosts,
                },
              }),
            "Update User"
          ),
        "Update User"
      );
    } else {
      wrapAdminAction(
        () =>
          requestPasswordConfirmation(
            () =>
              createMutation.mutate({
                username: formData.username,
                password: formData.password,
                displayName: formData.displayName,
                pageAccess: Array.from(selectedPages),
                hasErpAccess: formData.hasErpAccess,
                hasFactoryAccess: formData.hasFactoryAccess,
                hiddenCostFields,
                hideAllCosts,
              }),
            "Create User"
          ),
        "Create User"
      );
    }
  };

  const togglePage = (pageKey: string) => {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(pageKey)) next.delete(pageKey);
      else next.add(pageKey);
      return next;
    });
  };

  const toggleGroup = (group: string) => {
    const groupPages = ALL_FACTORY_PAGES.filter((p) => p.group === group).map((p) => p.key);
    const allSelected = groupPages.every((k) => selectedPages.has(k));
    setSelectedPages((prev) => {
      const next = new Set(prev);
      groupPages.forEach((k) => {
        if (allSelected) next.delete(k);
        else next.add(k);
      });
      return next;
    });
  };

  const selectAll = () => setSelectedPages(new Set(ALL_FACTORY_PAGES.map((p) => p.key)));

  const selectNone = () => setSelectedPages(new Set());

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <PageHeader title="Factory Users" subtitle="Create users and control which pages they can access" />
        </div>
        <Button
          onClick={() => {
            resetForm();
            setCreateOpen(true);
          }}
          data-testid="button-add-factory-user"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add User
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-lg">Users ({factoryUsers?.length || 0})</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {factoryUsers && factoryUsers.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Username</TableHead>
                    <TableHead>Display Name</TableHead>
                    <TableHead>ERP Access</TableHead>
                    <TableHead>Factory Access</TableHead>
                    <TableHead>Pages Access</TableHead>
                    <TableHead>Cost Access</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-28">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {factoryUsers.map((user) => (
                    <TableRow key={user.id} data-testid={`row-factory-user-${user.id}`}>
                      <TableCell className="font-medium font-mono">{user.username}</TableCell>
                      <TableCell className="text-muted-foreground">{user.displayName || "-"}</TableCell>
                      <TableCell>
                        <Switch
                          checked={isAdminOrOwner(user) ? true : (user.hasErpAccess ?? true)}
                          disabled={isAdminOrOwner(user) || toggleAccessMutation.isPending}
                          onCheckedChange={(checked) => {
                            wrapAdminAction(
                              () =>
                                requestPasswordConfirmation(
                                  () =>
                                    toggleAccessMutation.mutate({
                                      userId: user.id,
                                      data: { hasErpAccess: checked },
                                    }),
                                  "Update User"
                                ),
                              "Update User"
                            );
                          }}
                          data-testid={`switch-erp-access-${user.id}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={isAdminOrOwner(user) ? true : (user.hasFactoryAccess ?? true)}
                          disabled={isAdminOrOwner(user) || toggleAccessMutation.isPending}
                          onCheckedChange={(checked) => {
                            wrapAdminAction(
                              () =>
                                requestPasswordConfirmation(
                                  () =>
                                    toggleAccessMutation.mutate({
                                      userId: user.id,
                                      data: { hasFactoryAccess: checked },
                                    }),
                                  "Update User"
                                ),
                              "Update User"
                            );
                          }}
                          data-testid={`switch-factory-access-${user.id}`}
                        />
                      </TableCell>
                      <TableCell>
                        {user.pageAccess.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {user.pageAccess.length <= 3 ? (
                              user.pageAccess.map((pk) => {
                                const page = ALL_FACTORY_PAGES.find((p) => p.key === pk);
                                return (
                                  <Badge key={pk} variant="secondary">
                                    {page?.label || pk}
                                  </Badge>
                                );
                              })
                            ) : (
                              <Badge variant="secondary">{user.pageAccess.length} pages</Badge>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Full access</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isAdminOrOwner(user) ? (
                          <span className="text-xs text-muted-foreground">Full access</span>
                        ) : user.hideAllCosts ? (
                          <Badge variant="secondary">No cost access</Badge>
                        ) : user.hiddenCostFields.length > 0 ? (
                          <Badge variant="secondary">{user.hiddenCostFields.length} hidden</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">Full access</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={user.active ? "default" : "secondary"}>
                          {user.active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEdit(user)}
                            data-testid={`button-edit-user-${user.id}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {!isAdminOrOwner(user) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setDeletingUser(user)}
                              data-testid={`button-delete-user-${user.id}`}
                              className="text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="text-lg font-medium">No users configured</p>
              <p className="text-sm mt-1">Add users and assign them specific page access</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={createOpen || !!editingUser}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setEditingUser(null);
            resetForm();
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              {editingUser ? `Edit User: ${editingUser.username}` : "Add New User"}
            </DialogTitle>
            <DialogDescription>
              {editingUser
                ? "Update display name, password, or page access"
                : "Create a new user and choose which factory pages they can see"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Username *</Label>
                <Input
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  placeholder="Enter username"
                  data-testid="input-factory-user-username"
                />
                {editingUser && formData.username !== editingUser.username && (
                  <p className="text-xs text-muted-foreground mt-1">Username will be changed on save</p>
                )}
              </div>
              <div>
                <Label>{editingUser ? "New Password (leave blank to keep)" : "Password *"}</Label>
                <Input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  placeholder={editingUser ? "Leave blank to keep" : "Min 6 characters"}
                  data-testid="input-factory-user-password"
                />
              </div>
            </div>

            <div>
              <Label>Display Name</Label>
              <Input
                value={formData.displayName}
                onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                placeholder="Name shown in the system (e.g., John, Warehouse Manager)"
                data-testid="input-factory-user-display-name"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between rounded-md border p-3">
                <Label htmlFor="form-erp-access" className="cursor-pointer">
                  ERP Access
                </Label>
                <Switch
                  id="form-erp-access"
                  checked={editingUser && isAdminOrOwner(editingUser) ? true : formData.hasErpAccess}
                  disabled={!!editingUser && isAdminOrOwner(editingUser)}
                  onCheckedChange={(checked) => setFormData({ ...formData, hasErpAccess: checked })}
                  data-testid="switch-form-erp-access"
                />
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <Label htmlFor="form-factory-access" className="cursor-pointer">
                  Factory Access
                </Label>
                <Switch
                  id="form-factory-access"
                  checked={editingUser && isAdminOrOwner(editingUser) ? true : formData.hasFactoryAccess}
                  disabled={!!editingUser && isAdminOrOwner(editingUser)}
                  onCheckedChange={(checked) => setFormData({ ...formData, hasFactoryAccess: checked })}
                  data-testid="switch-form-factory-access"
                />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <Label className="text-base font-semibold">Page Access</Label>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={selectAll} data-testid="button-select-all-pages">
                    <Check className="h-3 w-3 mr-1" />
                    All
                  </Button>
                  <Button variant="outline" size="sm" onClick={selectNone} data-testid="button-select-none-pages">
                    <X className="h-3 w-3 mr-1" />
                    None
                  </Button>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Select which pages this user can see. If no pages are selected, the user gets full access.
              </p>

              <div className="space-y-4 border rounded-md p-4 max-h-80 overflow-y-auto">
                {PAGE_GROUPS.map((group) => {
                  const groupPages = ALL_FACTORY_PAGES.filter((p) => p.group === group);
                  const allGroupSelected = groupPages.every((p) => selectedPages.has(p.key));
                  const someGroupSelected = groupPages.some((p) => selectedPages.has(p.key));

                  return (
                    <div key={group} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={allGroupSelected}
                          ref={undefined}
                          onCheckedChange={() => toggleGroup(group)}
                          data-testid={`checkbox-group-${group.toLowerCase().replace(/\s+/g, "-")}`}
                        />
                        <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                          {group}
                        </span>
                        {someGroupSelected && !allGroupSelected && (
                          <span className="text-xs text-muted-foreground">(partial)</span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-1 ml-6">
                        {groupPages.map((page) => (
                          <div key={page.key} className="flex items-center gap-2">
                            <Checkbox
                              checked={selectedPages.has(page.key)}
                              onCheckedChange={() => togglePage(page.key)}
                              data-testid={`checkbox-page-${page.key.replace(/\//g, "-")}`}
                            />
                            <span className="text-sm">{page.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {selectedPages.size > 0 && (
                <p className="text-sm text-muted-foreground">{selectedPages.size} pages selected</p>
              )}
            </div>

            {!(editingUser && isAdminOrOwner(editingUser)) && (
              <div className="space-y-3">
                <div>
                  <Label className="text-base font-semibold">Cost Pricing Visibility</Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    Toggle off to hide cost pricing fields from this user. On = visible, Off = hidden.
                  </p>
                </div>
                {/* User mode — hides all costs in UI and in any downloaded files */}
                <div className="border rounded-md">
                  <div className="flex items-center justify-between px-4 py-3 bg-muted/40 rounded-t-md">
                    <div>
                      <span className="text-sm font-semibold">User</span>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Hide all costs in the app and in any downloaded/exported files
                      </p>
                    </div>
                    <Switch
                      checked={hideAllCosts}
                      onCheckedChange={(val) => {
                        setHideAllCosts(val);
                        if (val) setHiddenCostFields(COST_FIELDS.map((f) => f.key));
                        else setHiddenCostFields([]);
                      }}
                      data-testid="switch-hide-all-costs"
                    />
                  </div>
                  <div className={`divide-y ${hideAllCosts ? "opacity-40 pointer-events-none" : ""}`}>
                    {COST_FIELDS.map((field) => (
                      <div key={field.key} className="flex items-center justify-between px-4 py-3">
                        <span className="text-sm">{field.label}</span>
                        <Switch
                          checked={!hiddenCostFields.includes(field.key)}
                          onCheckedChange={() => toggleCostField(field.key)}
                          data-testid={`switch-cost-field-${field.key}`}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateOpen(false);
                setEditingUser(null);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={
                (!editingUser && (!formData.username || !formData.password)) ||
                createMutation.isPending ||
                updateMutation.isPending
              }
              data-testid="button-save-factory-user"
            >
              {createMutation.isPending || updateMutation.isPending ? "Saving..." : editingUser ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deletingUser}
        onOpenChange={(open) => {
          if (!open) setDeletingUser(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove User</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove <strong>{deletingUser?.username}</strong>? Their account will be
              deactivated and they will lose all access to this company.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeletingUser(null)} data-testid="button-cancel-delete-user">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                wrapAdminAction(
                  () =>
                    requestPasswordConfirmation(
                      () => deletingUser && deleteMutation.mutate(deletingUser.id),
                      "Remove User"
                    ),
                  "Remove User"
                )
              }
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-user"
            >
              {deleteMutation.isPending ? "Removing..." : "Remove User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {PasswordConfirmationDialog}
      {AdminDialog}
    </div>
  );
}
