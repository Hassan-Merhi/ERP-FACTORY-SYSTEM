import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import type { WorkerCategoryRow, WorkerOption } from "./types";

export function WorkerCategoriesManager({ compact = false }: { compact?: boolean }) {
  const { toast } = useToast();
  const appMode = useAppMode();
  const catApiRequest = getApiRequest(appMode);
  const [catDialogOpen, setCatDialogOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<WorkerCategoryRow | null>(null);
  const [catName, setCatName] = useState("");
  const [catWorkerIds, setCatWorkerIds] = useState<number[]>([]);

  const { data: catWorkers = [] } = useQuery<WorkerOption[]>({
    queryKey: ["/api/factory/workers"],
    queryFn: () => fetch("/api/factory/workers", { credentials: "include" }).then((r) => r.json()),
  });
  const { data: workerCategories = [], isLoading: catsLoading } = useQuery<WorkerCategoryRow[]>({
    queryKey: ["/api/factory/worker-categories"],
    queryFn: () => fetch("/api/factory/worker-categories", { credentials: "include" }).then((r) => r.json()),
  });

  const createCatMutation = useMutation({
    mutationFn: (data: { name: string; workerIds: number[] }) =>
      catApiRequest("POST", "/api/factory/worker-categories", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-categories"] });
      setCatDialogOpen(false);
      toast({ title: "Category created" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const updateCatMutation = useMutation({
    mutationFn: (data: { id: number; name: string; workerIds: number[] }) =>
      catApiRequest("PATCH", `/api/factory/worker-categories/${data.id}`, {
        name: data.name,
        workerIds: data.workerIds,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-categories"] });
      setCatDialogOpen(false);
      toast({ title: "Category updated" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const deleteCatMutation = useMutation({
    mutationFn: (id: number) => catApiRequest("DELETE", `/api/factory/worker-categories/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-categories"] });
      toast({ title: "Category deleted" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const openNewCat = () => {
    setEditingCat(null);
    setCatName("");
    setCatWorkerIds([]);
    setCatDialogOpen(true);
  };
  const openEditCat = (cat: WorkerCategoryRow) => {
    setEditingCat(cat);
    setCatName(cat.name);
    setCatWorkerIds(Array.isArray(cat.workerIds) ? cat.workerIds : []);
    setCatDialogOpen(true);
  };
  const toggleCatWorker = (id: number) =>
    setCatWorkerIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const saveCat = () => {
    if (!catName.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const activeIds = catWorkers.filter((w) => w.active !== false).map((w) => w.id);
    const filtered = catWorkerIds.filter((id) => activeIds.includes(id));
    if (editingCat) updateCatMutation.mutate({ id: editingCat.id, name: catName.trim(), workerIds: filtered });
    else createCatMutation.mutate({ name: catName.trim(), workerIds: filtered });
  };

  return (
    <div className={compact ? "space-y-3 rounded-lg border bg-card/50 p-3" : "space-y-4"}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Worker Groups</h2>
          <p className="text-xs text-muted-foreground">
            {compact
              ? "Create and assign teams used by this planner."
              : "Group workers for easier assignment during stock entry"}
          </p>
        </div>
        <Button onClick={openNewCat} size="sm" className="gap-2" data-testid="button-new-category">
          <Plus className="h-4 w-4" />
          New Group
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead>Group Name</TableHead>
              <TableHead>Workers</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catsLoading ? (
              <TableRow>
                <TableCell colSpan={3} className="h-32 text-center text-muted-foreground">
                  Loading groups...
                </TableCell>
              </TableRow>
            ) : workerCategories.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-32 text-center text-muted-foreground">
                  No worker groups created yet.
                </TableCell>
              </TableRow>
            ) : (
              workerCategories.map((cat) => (
                <TableRow key={cat.id}>
                  <TableCell className="font-bold">{cat.name}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {catWorkers
                        .filter((w) => (cat.workerIds || []).includes(w.id))
                        .map((w) => (
                          <Badge key={w.id} variant="secondary" className="text-[10px]">
                            {w.fullName || w.name}
                          </Badge>
                        ))}
                      {(cat.workerIds || []).length === 0 && (
                        <span className="text-xs text-muted-foreground italic">No workers assigned</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEditCat(cat)}
                        data-testid={`button-edit-category-${cat.id}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => {
                          if (confirm("Delete this group?")) deleteCatMutation.mutate(cat.id);
                        }}
                        data-testid={`button-delete-category-${cat.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={catDialogOpen} onOpenChange={setCatDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCat ? "Edit Group" : "New Worker Group"}</DialogTitle>
            <DialogDescription>Group workers to quickly filter the "Finalized By" dropdown.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Group Name</label>
              <Input
                value={catName}
                onChange={(e) => setCatName(e.target.value)}
                placeholder="e.g. Pressing Team"
                data-testid="input-category-name"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Assign Workers</label>
              <div className="grid grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-2">
                {catWorkers
                  .filter((w) => w.active !== false)
                  .map((w) => (
                    <div
                      key={w.id}
                      onClick={() => toggleCatWorker(w.id)}
                      className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${catWorkerIds.includes(w.id) ? "bg-primary/10 border-primary" : "hover:bg-muted"}`}
                      data-testid={`worker-option-${w.id}`}
                    >
                      <div
                        className={`h-4 w-4 rounded-sm border flex items-center justify-center ${catWorkerIds.includes(w.id) ? "bg-primary border-primary" : "bg-background border-input"}`}
                      >
                        {catWorkerIds.includes(w.id) && <CheckCircle className="h-3 w-3 text-white" />}
                      </div>
                      <span className="text-xs font-medium truncate">{w.fullName || w.name}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCatDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={saveCat}
              disabled={createCatMutation.isPending || updateCatMutation.isPending}
              data-testid="button-save-category"
            >
              {createCatMutation.isPending || updateCatMutation.isPending ? "Saving..." : "Save Group"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function WorkerCategoriesTab() {
  return <WorkerCategoriesManager />;
}
