import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, Search } from "lucide-react";
import type { InventoryLocation as Location, NegativeInventoryRow } from "./locationInventoryTypes";

interface LocationInventoryDialogsProps {
  // Create Location dialog
  createLocationOpen: boolean;
  setCreateLocationOpen: (open: boolean) => void;
  createLocationName: string;
  setCreateLocationName: (name: string) => void;
  createLocationMutation: {
    mutate: (name: string) => void;
    isPending: boolean;
  };

  // Negative stock dialog
  showNegativeStock: boolean;
  setShowNegativeStock: (v: boolean) => void;
  selectedLocationLocal: Location | null;
  negativeStockLoading: boolean;
  allNegativeStock: NegativeInventoryRow[];
  negativeSearchTerm: string;
  setNegativeSearchTerm: (s: string) => void;
}

export function LocationInventoryDialogs({
  createLocationOpen,
  setCreateLocationOpen,
  createLocationName,
  setCreateLocationName,
  createLocationMutation,
  showNegativeStock,
  setShowNegativeStock,
  selectedLocationLocal,
  negativeStockLoading,
  allNegativeStock,
  negativeSearchTerm,
  setNegativeSearchTerm,
}: LocationInventoryDialogsProps) {
  return (
    <>
      {/* Create Location dialog */}
      <Dialog open={createLocationOpen} onOpenChange={setCreateLocationOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create Location</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Label htmlFor="create-loc-name">Location Name</Label>
            <Input
              id="create-loc-name"
              value={createLocationName}
              onChange={(e) => setCreateLocationName(e.target.value)}
              placeholder="e.g. Warehouse A"
              data-testid="input-create-location-name"
              onKeyDown={(e) => {
                if (e.key === "Enter" && createLocationName.trim()) {
                  createLocationMutation.mutate(createLocationName.trim());
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateLocationOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createLocationMutation.mutate(createLocationName.trim())}
              disabled={createLocationMutation.isPending || !createLocationName.trim()}
              data-testid="button-confirm-create-location"
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Negative stock across all locations dialog */}
      <Dialog
        open={showNegativeStock && !selectedLocationLocal}
        onOpenChange={(open) => {
          if (!open) setShowNegativeStock(false);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" /> Negative Stock — All Locations
            </DialogTitle>
          </DialogHeader>
          <div className="relative shrink-0">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by item or location..."
              className="pl-8"
              value={negativeSearchTerm}
              onChange={(e) => setNegativeSearchTerm(e.target.value)}
              data-testid="input-negative-stock-search"
            />
          </div>
          <div className="flex-1 overflow-auto min-h-0">
            {negativeStockLoading ? (
              <p className="text-sm text-muted-foreground p-4">Loading…</p>
            ) : allNegativeStock.length === 0 ? (
              <p className="text-sm text-muted-foreground p-4">No negative stock found.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background border-b">
                  <tr>
                    <th className="text-left py-2 px-3 font-semibold">Item</th>
                    <th className="text-right py-2 px-3 font-semibold">Qty</th>
                    <th className="text-left py-2 px-3 font-semibold">Location</th>
                  </tr>
                </thead>
                <tbody>
                  {allNegativeStock
                    .filter((item) => {
                      if (!negativeSearchTerm) return true;
                      const s = negativeSearchTerm.toLowerCase();
                      return (
                        item.name.toLowerCase().includes(s) ||
                        item.code.toLowerCase().includes(s) ||
                        item.locationName.toLowerCase().includes(s)
                      );
                    })
                    .map((item) => (
                      <tr
                        key={`${item.stockItemId}-${item.locationId}`}
                        className="border-b border-muted/30 hover:bg-muted/20"
                      >
                        <td className="py-2 px-3 font-medium">
                          <div>{item.name}</div>
                          <div className="text-[11px] text-muted-foreground font-mono">{item.code}</div>
                        </td>
                        <td className="py-2 px-3 text-right font-bold text-destructive">
                          {parseFloat(item.quantity).toFixed(2)}
                        </td>
                        <td className="py-2 px-3 text-muted-foreground">{item.locationName}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
