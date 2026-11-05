/** Header-only destination assignment; never re-saves or reprices proforma lines. */
import type { useFactoryProformasModel } from "../../factoryproformas/useFactoryProformasModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Model = ReturnType<typeof useFactoryProformasModel>;

export function AssignProformaDestinationDialog({
  destinationProforma,
  setDestinationProforma,
  destinationValue,
  setDestinationValue,
  assignDestinationMutation,
}: {
  destinationProforma: Model["destinationProforma"];
  setDestinationProforma: Model["setDestinationProforma"];
  destinationValue: Model["destinationValue"];
  setDestinationValue: Model["setDestinationValue"];
  assignDestinationMutation: Model["assignDestinationMutation"];
}) {
  return (
    <Dialog
      open={!!destinationProforma}
      onOpenChange={(open) => {
        if (!open && !assignDestinationMutation.isPending) setDestinationProforma(null);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{destinationProforma?.destination ? "Change Destination" : "Assign Destination"}</DialogTitle>
          <DialogDescription>
            {destinationProforma?.name || "This proforma"} will use agreed prices saved for the selected destination.
            Linking it will not change any existing item prices or quantities.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="assign-proforma-destination">Destination</Label>
          <Input
            id="assign-proforma-destination"
            value={destinationValue}
            onChange={(event) => setDestinationValue(event.target.value)}
            placeholder="e.g. L'SHI, MALI, KINSHASA"
            list="assign-proforma-destinations"
            data-testid="input-assign-proforma-destination"
            autoFocus
          />
          <datalist id="assign-proforma-destinations">
            <option value="L'SHI" />
            <option value="MALI" />
            <option value="KINSHASA" />
          </datalist>
          <p className="text-xs text-muted-foreground">
            Saved prices for this destination can be applied separately in Edit Proforma.
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setDestinationProforma(null)}
            disabled={assignDestinationMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={!destinationValue.trim() || assignDestinationMutation.isPending}
            onClick={() => {
              if (!destinationProforma || !destinationValue.trim()) return;
              assignDestinationMutation.mutate({ id: destinationProforma.id, destination: destinationValue.trim() });
            }}
            data-testid="button-save-proforma-destination"
          >
            {assignDestinationMutation.isPending ? "Saving…" : "Save Destination"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
