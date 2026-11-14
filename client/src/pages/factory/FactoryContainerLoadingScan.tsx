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
import { PageHeader } from "@/components/PageHeader";
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
import type { RouteComponentProps } from "wouter";

/** Routed standalone (receives route props) or embedded as a hub tab panel. */
type EmbeddablePageProps = { embedded?: boolean } & Partial<RouteComponentProps>;

/**
 * `embedded`: rendered as the Invoicing / Loadings hub "Container Loadings" tab,
 * whose PageHeader already titles the page.
 */
export default function FactoryContainerLoadingScan({ embedded = false }: EmbeddablePageProps) {
  const model = useFactoryContainerLoadingScanModel();
  const { orderId, isResuming } = model;

  const orderBadges = orderId ? (
    isResuming ? (
      <Badge
        variant="secondary"
        className="max-w-full truncate bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200"
        data-testid="badge-resuming"
      >
        <Clock className="mr-1 h-3 w-3 shrink-0" />
        <span className="truncate">{model.tr("resuming", { orderId })}</span>
      </Badge>
    ) : (
      <Badge variant="secondary" data-testid="badge-loading-order">
        {model.tr("loadingNumber", { orderId })}
      </Badge>
    )
  ) : null;

  const orderActions = orderId ? (
    <div className="flex flex-wrap items-center gap-2">
      {model.orderDetail?.proformaIdUsed && (
        <ContainerExtraItemsDialog
          orderId={orderId}
          customerId={model.orderDetail.customerId}
          status={model.orderDetail.status}
        />
      )}
      <div className="flex items-center gap-2 rounded-xl border border-blue-200/80 bg-white/80 px-3 py-2 shadow-sm dark:border-blue-400/25 dark:bg-card/75">
        <Package className="h-5 w-5 text-blue-600 dark:text-sky-400" />
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {model.tr("bales")}
          </div>
          <div className="font-mono text-sm font-bold">{model.bales.length}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 rounded-xl border border-blue-200/80 bg-white/80 px-3 py-2 shadow-sm dark:border-blue-400/25 dark:bg-card/75">
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
  ) : null;

  return (
    <div
      className="flex h-full min-w-0 flex-col bg-background p-3 sm:p-4 lg:p-6"
      data-testid="factory-container-loading-page"
    >
      <ScanOverlays model={model} />

      {embedded ? (
        // Invoicing / Loadings hub tab: the hub PageHeader titles the page; keep the order context and counters.
        (orderBadges || orderActions) && (
          <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">{orderBadges}</div>
            {orderActions}
          </div>
        )
      ) : (
        <PageHeader
          title={model.tr("containerLoading")}
          subtitle={model.tr("containerLoadingSubtitle")}
          icon={<Container className="h-5 w-5" />}
          meta={orderBadges}
        >
          {orderActions}
        </PageHeader>
      )}

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
