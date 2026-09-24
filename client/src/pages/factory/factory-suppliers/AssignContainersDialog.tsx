import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, Package } from "lucide-react";

export interface DirectContainer {
  id: number;
  containerNumber: string;
  status: string;
  currencyCode: string;
  totalKg: string | null;
  ratePerKg: string | null;
  finalPayableAmount: string | null;
  arrivalDate: string | null;
  origin: string | null;
}

interface AssignContainersDialogProps {
  open: boolean;
  onClose: () => void;
  linkedSupplier: { id: number; name: string } | null;
  containers: DirectContainer[];
  onAssign: (containerIds: number[]) => void;
  isPending: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  IN_TRANSIT: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  ARRIVED: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  OFFLOADED: "bg-muted text-muted-foreground",
};

function fmtKg(v: string | null) {
  if (!v) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " kg";
}

function fmtAmt(v: string | null, cc: string) {
  if (!v) return null;
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  return `${cc === "USD" ? "$" : cc + " "}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function AssignContainersDialog({
  open,
  onClose,
  linkedSupplier,
  containers,
  onAssign,
  isPending,
}: AssignContainersDialogProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return containers;
    return containers.filter((c) => searchAny(search, c.containerNumber, c.origin, c.status));
  }, [containers, search]);

  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((c) => c.id)));
    }
  };

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = () => {
    if (selected.size === 0) return;
    onAssign(Array.from(selected));
  };

  const handleClose = () => {
    setSelected(new Set());
    setSearch("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Assign Containers → {linkedSupplier?.name}</DialogTitle>
          <p className="text-sm text-muted-foreground pt-1">
            Select containers currently held directly under the broker to move to this linked supplier. Commission stays
            with the broker.
          </p>
        </DialogHeader>

        {containers.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-10 text-muted-foreground">
            <Package className="h-10 w-10 mb-2 opacity-30" />
            <p className="text-sm">No direct containers to assign.</p>
          </div>
        ) : (
          <>
            {/* Search + select-all */}
            <div className="flex items-center gap-2 py-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search containers..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 h-8 text-sm"
                />
              </div>
              <Button variant="ghost" size="sm" onClick={toggleAll} className="text-xs shrink-0">
                {selected.size === filtered.length && filtered.length > 0 ? "Deselect All" : "Select All"}
              </Button>
            </div>

            {/* Container list */}
            <div className="overflow-y-auto flex-1 -mx-1 px-1 divide-y border rounded-md">
              {filtered.map((c) => (
                <label
                  key={c.id}
                  className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/40 transition-colors"
                >
                  <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} className="mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-semibold text-sm">{c.containerNumber}</span>
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_COLORS[c.status] || "bg-muted text-muted-foreground"}`}
                      >
                        {c.status}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{c.currencyCode}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      {c.origin && <span>{c.origin}</span>}
                      {fmtKg(c.totalKg) && <span>{fmtKg(c.totalKg)}</span>}
                      {fmtAmt(c.finalPayableAmount, c.currencyCode) && (
                        <span className="font-medium text-foreground">
                          {fmtAmt(c.finalPayableAmount, c.currencyCode)}
                        </span>
                      )}
                      {c.arrivalDate && <span>{c.arrivalDate}</span>}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </>
        )}

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={handleClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={selected.size === 0 || isPending}>
            {isPending
              ? "Assigning..."
              : `Assign ${selected.size > 0 ? selected.size + " " : ""}Container${selected.size !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
