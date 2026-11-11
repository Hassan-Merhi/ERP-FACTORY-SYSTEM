/**
 * Factory container loading scan page shell.
 *
 * Keeps its route and default export. The order lifecycle, scanner, bypass
 * rules, Excel import and proforma comparison live in
 * ./factorycontainerloadingscan/useFactoryContainerLoadingScanModel; the
 * overlays, bale panel, setup card, progress panel and dialogs are separate
 * views in the same folder.
 */
import { CheckCircle, Clock, Container, Package, Save, Scale } from "lucide-react";
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
import { ContainerExtraItemsDialog } from "./ContainerExtraItemsDialog";

export default function FactoryContainerLoadingScan() {
  const model = useFactoryContainerLoadingScanModel();
  const { orderId, isResuming } = model;

  return (
    <div
      className="flex h-full min-w-0 flex-col bg-background p-3 sm:p-4 lg:p-6"
      data-testid="factory-container-loading-page"
    >
      <ScanOverlays model={model} />

      <div className="relative isolate mb-4 overflow-hidden rounded-[22px] border border-blue-200/70 bg-gradient-to-r from-white via-blue-50/80 to-sky-100/70 px-4 py-4 shadow-[0_16px_40px_-32px_hsl(var(--factory-hue)_83%_53%_/_0.65)] dark:border-blue-500/30 dark:from-blue-950 dark:via-blue-900 dark:to-blue-800 sm:px-5 sm:py-5">
        {/* Decorative freight-container artwork; no loading or scan behavior lives here. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 hidden w-1/3 overflow-hidden lg:block"
        >
          <div className="absolute inset-0 bg-gradient-to-r from-blue-50/0 via-sky-300/5 to-blue-500/10 dark:from-transparent dark:to-blue-500/20" />
          <div className="factory-container-stripes absolute -right-8 top-5 h-24 w-[85%] -skew-x-12 rounded-lg border border-blue-700/20 shadow-[0_18px_40px_hsl(var(--factory-hue)_100%_20%_/_0.25)] dark:border-sky-300/35" />
          <div className="absolute -right-5 top-5 h-24 w-[85%] -skew-x-12 rounded-lg bg-gradient-to-t from-blue-950/30 to-sky-300/15" />
        </div>
        <div className="relative z-10 flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-blue-300/70 bg-gradient-to-br from-blue-500 to-indigo-700 text-white shadow-lg shadow-blue-500/20 dark:border-sky-400/35">
              <Container className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="truncate text-lg font-bold tracking-tight sm:text-[22px]">
                  {model.tr("containerLoading")}
                </h1>
                {isResuming && orderId && (
                  <Badge
                    variant="secondary"
                    className="max-w-full truncate bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200"
                    data-testid="badge-resuming"
                  >
                    <Clock className="mr-1 h-3 w-3 shrink-0" />
                    <span className="truncate">{model.tr("resuming", { orderId })}</span>
                  </Badge>
                )}
                {!isResuming && orderId && (
                  <Badge variant="secondary" data-testid="badge-loading-order">
                    {model.tr("loadingNumber", { orderId })}
                  </Badge>
                )}
              </div>
              <p className="mt-1 max-w-[540px] text-xs text-slate-600 dark:text-blue-100/75 sm:text-sm">
                {model.tr("containerLoadingSubtitle")}
              </p>
            </div>
          </div>
          {orderId && (
            <div className="flex flex-wrap items-center gap-2 lg:mr-[17%]">
              {model.orderDetail?.proformaIdUsed && (
                <ContainerExtraItemsDialog
                  orderId={orderId}
                  customerId={model.orderDetail.customerId}
                  status={model.orderDetail.status}
                />
              )}
              <div className="flex items-center gap-2 rounded-xl border border-blue-200/80 bg-white/80 px-3 py-2 shadow-sm backdrop-blur-sm dark:border-blue-400/25 dark:bg-card/75">
                <Package className="h-5 w-5 text-blue-600 dark:text-sky-400" />
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {model.tr("bales")}
                  </div>
                  <div className="font-mono text-sm font-bold">{model.bales.length}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-blue-200/80 bg-white/80 px-3 py-2 shadow-sm backdrop-blur-sm dark:border-blue-400/25 dark:bg-card/75">
                <Scale className="h-5 w-5 text-blue-600 dark:text-sky-400" />
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {model.tr("weight")}
                  </div>
                  <div className="font-mono text-sm font-bold">
                    {formatNumber(model.totalWeight, 2)} {model.tr("kgUnit")}
                  </div>
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
            <div className="mobile-action-bar grid grid-cols-1 gap-2 rounded-[22px] border border-blue-100 bg-white/95 p-2 shadow-sm backdrop-blur-sm dark:border-blue-500/20 dark:bg-card/95 sm:grid-cols-2 xl:static xl:m-0 xl:grid-cols-1">
              <Button
                variant="outline"
                className="h-11 w-full"
                onClick={() => model.navigate("/factory/sales/loading/pending")}
                data-testid="button-save-exit"
              >
                <Save className="mr-2 h-4 w-4" />
                {model.tr("saveAndExit")}
              </Button>
              {model.canChangeExistingRecords && (
                <Button
                  className="h-11 w-full rounded-xl bg-gradient-to-r from-sky-500 to-blue-700 font-semibold text-white shadow-md shadow-blue-500/20 hover:from-sky-600 hover:to-blue-800"
                  onClick={() => model.setShowFinalizeDialog(true)}
                  disabled={model.bales.length === 0 || model.finalizeMutation.isPending}
                  data-testid="button-finalize-loading"
                >
                  <CheckCircle className="mr-2 h-5 w-5" />
                  {model.tr("validateFinalize")}
                </Button>
              )}
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
