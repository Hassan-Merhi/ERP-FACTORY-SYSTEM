// Extracted from ./SilentProductionDialog.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";
import { useSilentProductionDialogState } from "./useSilentProductionDialogState";
import { SilentProductionDialogSectionContent } from "./SilentProductionDialogSectionContent";

export function SilentProductionDialogSection({
  allStockItems,
  setSilentProdApplying,
  setSilentProdDone,
  setSilentProdItems,
  setSilentProdOpen,
  setSilentProdSearchTerm,
  setSilentProdType,
  silentLocInventory,
  silentLocInventoryLoading,
  silentProdApplying,
  silentProdItems,
  silentProdLocId,
  silentProdSearchTerm,
  silentProdType,
}: Pick<
  ReturnType<typeof useSilentProductionDialogState>,
  | "allStockItems"
  | "setSilentProdApplying"
  | "setSilentProdDone"
  | "setSilentProdItems"
  | "setSilentProdOpen"
  | "setSilentProdSearchTerm"
  | "setSilentProdType"
  | "silentLocInventory"
  | "silentLocInventoryLoading"
  | "silentProdApplying"
  | "silentProdItems"
  | "silentProdLocId"
  | "silentProdSearchTerm"
  | "silentProdType"
>) {
  return (
    <>
      <div className="flex gap-2">
        <Button
          variant={silentProdType === "Production" ? "default" : "outline"}
          size="sm"
          onClick={() => setSilentProdType("Production")}
          data-testid="button-type-production"
        >
          Production (+)
        </Button>
        <Button
          variant={silentProdType === "Consumption" ? "default" : "outline"}
          size="sm"
          onClick={() => setSilentProdType("Consumption")}
          data-testid="button-type-consumption"
        >
          Consumption (−)
        </Button>
      </div>

      <SilentProductionDialogSectionContent
        allStockItems={allStockItems}
        setSilentProdItems={setSilentProdItems}
        setSilentProdSearchTerm={setSilentProdSearchTerm}
        silentLocInventory={silentLocInventory}
        silentLocInventoryLoading={silentLocInventoryLoading}
        silentProdItems={silentProdItems}
        silentProdLocId={silentProdLocId}
        silentProdSearchTerm={silentProdSearchTerm}
        silentProdType={silentProdType}
      />

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setSilentProdOpen(false)} data-testid="button-silent-prod-cancel">
          Cancel
        </Button>
        <Button
          disabled={
            !silentProdLocId || silentProdItems.every((row) => !row.stockItemId || !row.quantity) || silentProdApplying
          }
          onClick={async () => {
            const validItems = silentProdItems.filter((row) => row.stockItemId && row.quantity);
            if (!silentProdLocId || validItems.length === 0) return;
            setSilentProdApplying(true);
            try {
              const res = await apiRequest("POST", "/api/inventory/silent-production", {
                locationId: silentProdLocId,
                type: silentProdType,
                items: validItems.map((row) => ({
                  stockItemId: row.stockItemId,
                  quantity: row.quantity,
                  rate: row.rate || "0",
                })),
              });
              const data = await res.json();
              setSilentProdDone(data.applied || validItems.length);
            } catch (error: unknown) {
              console.error("Silent production error:", error);
            } finally {
              setSilentProdApplying(false);
            }
          }}
          data-testid="button-silent-prod-apply"
        >
          {silentProdApplying ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Applying...
            </>
          ) : (
            `Apply ${silentProdType}`
          )}
        </Button>
      </div>
    </>
  );
}
