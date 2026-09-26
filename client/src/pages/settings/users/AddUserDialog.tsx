import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { usePasswordConfirmedAction } from "@/hooks/use-password-confirmed-action";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { UserPlus } from "lucide-react";

interface AddUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddUserDialog({ open, onOpenChange }: AddUserDialogProps) {
  const { toast } = useToast();
  const { requestPasswordConfirmation, PasswordConfirmationDialog } = usePasswordConfirmedAction();
  const [form, setForm] = useState({
    username: "",
    password: "",
    displayName: "",
    hasErpAccess: true,
    hasFactoryAccess: true,
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof form) => {
      const res = await factoryApiRequest("POST", "/api/factory/users", data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to create user");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/users"] });
      toast({ title: "User created", description: `${form.username} has been added` });
      setForm({ username: "", password: "", displayName: "", hasErpAccess: true, hasFactoryAccess: true });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    if (!form.username.trim() || !form.password.trim()) {
      toast({ title: "Required fields", description: "Username and password are required", variant: "destructive" });
      return;
    }
    if (form.password.length < 4) {
      toast({
        title: "Password too short",
        description: "Password must be at least 4 characters",
        variant: "destructive",
      });
      return;
    }
    requestPasswordConfirmation(() => createMutation.mutate(form), "Create User");
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) setForm({ username: "", password: "", displayName: "", hasErpAccess: true, hasFactoryAccess: true });
          onOpenChange(v);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5" />
              Add New User
            </DialogTitle>
            <DialogDescription>Create a login account. You can configure permissions after creation.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="add-username">Username *</Label>
                <Input
                  id="add-username"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="e.g. john.doe"
                  data-testid="input-add-username"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-password">Password *</Label>
                <Input
                  id="add-password"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="Min 4 characters"
                  data-testid="input-add-password"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="add-displayname">Display Name</Label>
              <Input
                id="add-displayname"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="Name shown in the system (e.g. Warehouse Manager)"
                data-testid="input-add-display-name"
              />
            </div>

            <div className="space-y-2 pt-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">App Access</p>
              <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <p className="text-sm font-medium">ERP</p>
                    <p className="text-xs text-muted-foreground">Accounting &amp; sales</p>
                  </div>
                  <Switch
                    checked={form.hasErpAccess}
                    onCheckedChange={(v) => setForm({ ...form, hasErpAccess: v })}
                    data-testid="switch-add-erp-access"
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <p className="text-sm font-medium">Factory</p>
                    <p className="text-xs text-muted-foreground">Production &amp; bales</p>
                  </div>
                  <Switch
                    checked={form.hasFactoryAccess}
                    onCheckedChange={(v) => setForm({ ...form, hasFactoryAccess: v })}
                    data-testid="switch-add-factory-access"
                  />
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={createMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={createMutation.isPending} data-testid="button-create-user-submit">
              {createMutation.isPending ? "Creating..." : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {PasswordConfirmationDialog}
    </>
  );
}
