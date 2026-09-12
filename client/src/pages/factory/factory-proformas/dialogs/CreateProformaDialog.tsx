/**
 * CreateProformaDialog — extracted from FactoryProformas.tsx during the P1
 * god-file split, following the Phase 4 dialog extraction pattern.
 *
 * Props are the parent-scope bindings the block referenced, typed from the
 * page model.
 */
import type { useFactoryProformasModel } from "../../factoryproformas/useFactoryProformasModel";

type FactoryProformasModel = ReturnType<typeof useFactoryProformasModel>;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function CreateProformaDialog({
  isCreateOpen,
  setIsCreateOpen,
  newProformaName,
  setNewProformaName,
  createProformaMutation,
  handleCreateProforma,
}: {
  isCreateOpen: FactoryProformasModel["isCreateOpen"];
  setIsCreateOpen: FactoryProformasModel["setIsCreateOpen"];
  newProformaName: FactoryProformasModel["newProformaName"];
  setNewProformaName: FactoryProformasModel["setNewProformaName"];
  createProformaMutation: FactoryProformasModel["createProformaMutation"];
  handleCreateProforma: FactoryProformasModel["handleCreateProforma"];
}) {
  return (
    <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create New Proforma</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label className="text-sm font-medium mb-1 block">Proforma Name</label>
            <Input
              placeholder="e.g. Summer 2024 Pricing"
              value={newProformaName}
              onChange={(e) => setNewProformaName(e.target.value)}
              data-testid="input-proforma-name"
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setIsCreateOpen(false)} data-testid="button-cancel-create">
              Cancel
            </Button>
            <Button
              onClick={handleCreateProforma}
              disabled={!newProformaName.trim() || createProformaMutation.isPending}
              data-testid="button-confirm-create"
            >
              Create Proforma
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
