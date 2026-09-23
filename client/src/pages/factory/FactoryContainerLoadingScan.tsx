/**
 * Factory container loading scan page shell.
 *
 * Keeps its route and default export. The order lifecycle, scanner, bypass
 * rules, Excel import and proforma comparison live in
 * ./factorycontainerloadingscan/useFactoryContainerLoadingScanModel; the
 * overlays, bale panel, setup card, progress panel and dialogs are separate
 * views in the same folder.
 */
import { CheckCircle, Clock, Package, Save, Scale, ScanLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatNumber } from "./customerLoadingFormat";
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
    <div
      className="flex h-full min-w-0 flex-col bg-muted/10 p-3 sm:p-4 lg:p-6"
      data-testid="factory-container-loading-page"
    >
      <ScanOverlays model={model} />

      <div className="mb-4 rounded-2xl border bg-background/90 px-4 py-3 shadow-sm sm:px-5 sm:py-4">
        <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-primary/10">
              <ScanLine className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="truncate text-lg font-semibold leading-tight sm:text-xl">Container Loading</h1>
                {isResuming && orderId && (
                  <Badge
                    variant="secondary"
                    className="max-w-full truncate bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200"
                    data-testid="badge-resuming"
                  >
                    <Clock className="mr-1 h-3 w-3 shrink-0" />
                    <span className="truncate">Resuming #{orderId}</span>
                  </Badge>
                )}
                {!isResuming && orderId && (
                  <Badge variant="secondary" data-testid="badge-loading-order">
                    Loading #{orderId}
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
                Scan, verify and prepare the container without leaving this workspace.
              </p>
            </div>
          </div>

          {orderId && (
            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
              <div className="flex items-center gap-2 rounded-xl border bg-muted/20 px-3 py-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-background">
                  <Package className="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Bales</div>
                  <div className="font-mono text-sm font-semibold">{model.bales.length}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-xl border bg-muted/20 px-3 py-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-background">
                  <Scale className="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Weight</div>
                  <div className="font-mono text-sm font-semibold">{formatNumber(model.totalWeight, 2)} kg</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 xl:flex-row">
        <ScannedBalesPanel model={model} />

        <div className="flex min-w-0 flex-col gap-4 xl:w-[40%]">
          <LoadingSetupCard model={model} />
          <ProformaProgressPanel model={model} />

          {orderId && (
            <div className="mobile-action-bar grid grid-cols-1 gap-2 rounded-2xl border bg-background/95 p-2 shadow-sm backdrop-blur sm:grid-cols-2 xl:static xl:m-0 xl:grid-cols-1 xl:bg-background/90">
              <Button
                variant="outline"
                className="h-11 w-full"
                onClick={() => model.navigate("/factory/sales/loading/pending")}
                data-testid="button-save-exit"
              >
                <Save className="mr-2 h-4 w-4" />
                Save &amp; Exit
              </Button>
              <Button
                className="h-11 w-full"
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

      <ImportBalesDialog model={model} />
      <FinalizeLoadingDialog model={model} />
      <LoadingScanDialogs model={model} />
    </div>
  );
}
