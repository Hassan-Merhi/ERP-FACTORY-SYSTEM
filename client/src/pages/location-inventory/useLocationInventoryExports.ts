import { getErrorDetails } from "@shared/errorUtils";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import type { InventoryLocation as Location } from "./locationInventoryTypes";

export function useLocationInventoryExports(
  selectedLocationLocal: Location | null,
  toast: (opts: { title: string; description?: string; variant?: "destructive" | "default" }) => void
) {
  const handlePrintWithOption = async (withCost: boolean) => {
    if (!selectedLocationLocal) return;
    try {
      const includeCost = withCost ? "1" : "0";
      await downloadFromUrl(`/api/locations/${selectedLocationLocal.id}/inventory/pdf?includeCost=${includeCost}`, {
        fileName: exportFileName(`${selectedLocationLocal.name} godown ${withCost ? "with cost" : "no cost"}`, "pdf"),
      });
      toast({ title: "PDF Downloaded" });
    } catch (error) {
      toast({ title: "Export failed", description: getErrorDetails(error).message, variant: "destructive" });
    }
  };

  const handlePrintGroup = async (group: { groupId: number | null; groupName: string }, withCost: boolean) => {
    if (!selectedLocationLocal) return;
    try {
      const includeCost = withCost ? "1" : "0";
      const groupPathParam = group.groupId === null ? "none" : group.groupId;
      await downloadFromUrl(
        `/api/locations/${selectedLocationLocal.id}/inventory/pdf/stock-group/${groupPathParam}?includeCost=${includeCost}`,
        {
          fileName: exportFileName(
            `${selectedLocationLocal.name} ${group.groupName} ${withCost ? "with cost" : "no cost"}`,
            "pdf"
          ),
        }
      );
      toast({ title: "PDF Downloaded" });
    } catch (error) {
      toast({ title: "Export failed", description: getErrorDetails(error).message, variant: "destructive" });
    }
  };

  const handleExportInventory = async () => {
    if (!selectedLocationLocal) return;
    try {
      await downloadFromUrl(`/api/locations/${selectedLocationLocal.id}/inventory/export`, {
        fileName: exportFileName(`${selectedLocationLocal.name} inventory`, "xlsx"),
      });
      toast({ title: "Export Successful" });
    } catch (error) {
      toast({ title: "Export failed", description: getErrorDetails(error).message, variant: "destructive" });
    }
  };

  return { handlePrintWithOption, handleExportInventory, handlePrintGroup };
}
