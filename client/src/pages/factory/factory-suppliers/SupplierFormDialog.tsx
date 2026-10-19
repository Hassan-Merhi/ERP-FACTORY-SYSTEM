import type { useFactorySuppliersModel } from "./useFactorySuppliersModel";

type FactorySuppliersModel = ReturnType<typeof useFactorySuppliersModel>;
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SupplierWithBalance } from "./factorySupplierTypes";
import { FactorySupplier } from "@shared/schema";

interface SupplierFormDialogProps {
  createOpen: boolean;
  setCreateOpen: (val: boolean) => void;
  editingSupplier: FactorySupplier | null;
  setEditingSupplier: (val: FactorySupplier | null) => void;
  formData: FactorySuppliersModel["formData"];
  setFormData: FactorySuppliersModel["setFormData"];
  formRole: "broker" | "standalone" | "linked";
  setFormRole: (val: "broker" | "standalone" | "linked") => void;
  allSuppliers: SupplierWithBalance[];
  createSubAccountParentId: number | null;
  setCreateSubAccountParentId: (val: number | null) => void;
  createMutation: FactorySuppliersModel["createMutation"];
  updateMutation: FactorySuppliersModel["updateMutation"];
  resetForm: () => void;
  wrapAdminAction: (fn: () => void, title: string) => void;
}

export function SupplierFormDialog({
  createOpen,
  setCreateOpen,
  editingSupplier,
  setEditingSupplier,
  formData,
  setFormData,
  formRole,
  setFormRole,
  allSuppliers,
  createSubAccountParentId,
  setCreateSubAccountParentId,
  createMutation,
  updateMutation,
  resetForm,
  wrapAdminAction,
}: SupplierFormDialogProps) {
  const brokers = allSuppliers.filter((s) => !s.parentId && s.isActive !== false);

  const handleSubmit = () => {
    // Derive isBroker + parentId from the current formRole so the type change
    // is always persisted, regardless of whether we're creating or editing.
    const rolePayload =
      formRole === "broker"
        ? { isBroker: true, parentId: null }
        : formRole === "linked"
          ? { isBroker: false, parentId: formData.parentId ?? null }
          : { isBroker: false, parentId: null };

    if (editingSupplier) {
      updateMutation.mutate({ id: editingSupplier.id, ...formData, ...rolePayload });
    } else {
      createMutation.mutate({ ...formData, ...rolePayload });
    }
  };

  return (
    <Dialog
      open={createOpen || !!editingSupplier}
      onOpenChange={(open) => {
        if (!open) {
          setCreateOpen(false);
          setEditingSupplier(null);
          setCreateSubAccountParentId(null);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editingSupplier ? "Edit Supplier" : "Add New Supplier"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Account Type</Label>
            <Select
              value={formRole}
              onValueChange={(v) => {
                if (v !== "broker" && v !== "standalone" && v !== "linked") return;
                setFormRole(v);
                if (v !== "linked") setFormData({ ...formData, parentId: null });
              }}
              disabled={!!createSubAccountParentId}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standalone">Standalone Supplier</SelectItem>
                <SelectItem value="broker">Broker (Parent Account)</SelectItem>
                <SelectItem value="linked">Linked Supplier (Sub-Account)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {formRole === "linked" && (
            <div className="space-y-2">
              <Label>Parent Broker</Label>
              <Select
                value={String(formData.parentId || "")}
                onValueChange={(v) => setFormData({ ...formData, parentId: parseInt(v) })}
                disabled={!!createSubAccountParentId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select broker" />
                </SelectTrigger>
                <SelectContent>
                  {brokers.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="Supplier or Broker name"
              data-testid="input-supplier-name"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Contact Person</Label>
              <Input
                value={formData.contactPerson}
                onChange={(e) => setFormData({ ...formData, contactPerson: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Address</Label>
            <Input value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Input value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setCreateOpen(false);
              setEditingSupplier(null);
              setCreateSubAccountParentId(null);
              resetForm();
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => wrapAdminAction(handleSubmit, editingSupplier ? "Update Supplier" : "Create Supplier")}
            disabled={createMutation.isPending || updateMutation.isPending || !formData.name}
            data-testid="button-save-supplier"
          >
            {createMutation.isPending || updateMutation.isPending ? "Saving..." : editingSupplier ? "Update" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
