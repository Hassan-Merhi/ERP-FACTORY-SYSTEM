/**
 * Factory container loading scan page shell.
 *
 * Keeps its route and default export. The order lifecycle, scanner, bypass
 * rules, Excel import and proforma comparison live in
 * ./factorycontainerloadingscan/useFactoryContainerLoadingScanModel; the
 * overlays, bale panel, setup card, progress panel and dialogs are separate
 * views in the same folder.
 */
import { CheckCircle, Clock, Save, ScanLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFactoryContainerLoadingScanModel } from "./factorycontainerloadingscan/useFactoryContainerLoadingScanModel";
import { ScanOverlays } from "./factorycontainerloadingscan/ScanOverlays";
import { ScannedBalesPanel } from "./factorycontainerloadingscan/ScannedBalesPanel";
import { LoadingSetupCard } from "./factorycontainerloadingscan/LoadingSetupCard";
import { ProformaProgressPanel } from "./factorycontainerloadingscan/ProformaProgressPanel";
import { ImportBalesDialog } from "./factorycontainerloadingscan/ImportBalesDialog";
import { FinalizeLoadingDialog } from "./factorycontainerloadingscan/FinalizeLoadingDialog";
import { LoadingScanDialogs } from "./factorycontainerloadingscan/LoadingScanDialogs";

export default function FactoryContainerLoadingScan() {
  const model = useFactoryContainerLoadingScanModel();
  const { orderId, isResuming } = model;

  return (
    <div className="flex h-full min-w-0 flex-col p-3 sm:p-4 lg:p-6" data-testid="factory-container-loading-page">
      <ScanOverlays model={model} />

      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3 sm:gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <ScanLine className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-tight">Container Loading</h1>
            <p className="text-xs text-muted-foreground">Floor loader bale scanning</p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {isResuming && orderId && (
            <Badge
              variant="secondary"
              className="max-w-full truncate bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 no-default-hover-elevate no-default-active-elevate"
              data-testid="badge-resuming"
            >
              <Clock className="h-3 w-3 mr-1 shrink-0" />
              <span className="truncate">Resuming Loading #{orderId}</span>
            </Badge>
          )}
          {!isResuming && orderId && (
            <Badge variant="secondary" data-testid="badge-loading-order">
              Loading #{orderId}
            </Badge>
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 lg:flex-row">
        {/* Left: scanned bales */}
        <ScannedBalesPanel model={model} />

        {/* Right: controls + proforma panel */}
        <div className="flex min-w-0 flex-col gap-4 lg:w-[40%]">
          {/* Setup card — hidden once order started and proforma is showing */}
          <LoadingSetupCard model={model} />

          {/* Proforma progress panel — shown when order is active and a proforma is linked */}
          <ProformaProgressPanel model={model} />

          {/* Save & Exit + Validate & Finalize */}
          {orderId && (
            <div className="mobile-action-bar flex flex-col gap-2 sm:static sm:m-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => model.navigate("/factory/sales/loading/pending")}
                data-testid="button-save-exit"
              >
                <Save className="mr-2 h-4 w-4" />
                Save &amp; Exit
              </Button>
              <Button
                className="w-full"
                size="lg"
                onClick={() => model.setShowFinalizeDialog(true)}
                disabled={model.bales.length === 0 || model.finalizeMutation.isPending}
                data-testid="button-finalize-loading"
              >
                <CheckCircle className="mr-2 h-5 w-5" />
                Validate &amp; Finalize
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Import from Excel Dialog */}
      <ImportBalesDialog model={model} />

      {/* Validate & Finalize Dialog */}
      <FinalizeLoadingDialog model={model} />

      <LoadingScanDialogs model={model} />
    </div>
  );
}
