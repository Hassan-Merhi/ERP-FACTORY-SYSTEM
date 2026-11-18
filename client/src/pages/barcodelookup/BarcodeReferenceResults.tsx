import {
  AlertTriangle,
  ArchiveRestore,
  ArrowLeftRight,
  CheckCircle2,
  Clock,
  Hash,
  History,
  Layers,
  Pencil,
  Trash2,
  Undo2,
  User,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BaleStatusBadge } from "./components/BaleStatusBadge";
import { InfoRow } from "./components/InfoRow";
import {
  LinkedProductCard,
  LoadedOrderCard,
  MixBatchCard,
  PressingBatchCard,
  SourceContainersCard,
  type BarcodeLookupModel,
} from "./BarcodeReferenceResultsLoadedOrderCard";

export function BarcodeReferenceResults({ model }: { model: BarcodeLookupModel }) {
  const result = model.referenceResult;
  if (!result) return null;

  if (!result.labelPrint) {
    return (
      <div className="rounded-2xl border border-blue-200/70 bg-linear-to-br from-blue-50 to-white p-8 text-center text-muted-foreground shadow-sm dark:border-blue-400/25 dark:from-slate-900 dark:to-slate-950">
        <Hash className="h-10 w-10 mx-auto mb-3 opacity-25" />
        <p className="text-sm">
          No record found for reference "<span className="font-mono">{model.searchValue}</span>"
        </p>
      </div>
    );
  }

  const { labelPrint, baleInfo } = result;
  // V5 stores the bale as IN_STOCK until finalization, but a live order
  // assignment makes its effective status LOADING in Bale Explorer.
  const isOpenLoading = ["DRAFT", "LOADING"].includes(result.loadedOnOrder?.status ?? "");
  const canReturnToStock = isOpenLoading || ["RESERVED_FOR_ORDER", "RESERVED", "SOLD"].includes(baleInfo?.status ?? "");
  const openSwap = () => {
    model.setSwapRef("");
    model.setSwapPreview(null);
    model.setShowSwapDialog(true);
  };
  const openProductChange = () => {
    model.setSelectedNewProductId(null);
    model.setChangeProductSearch("");
    model.setShowChangeProductDialog(true);
  };

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-indigo-200/80 bg-white shadow-[0_12px_38px_-24px_rgba(30,64,175,0.35)] dark:border-indigo-400/25 dark:bg-[#111b31] dark:shadow-[0_16px_44px_-25px_rgba(79,70,229,0.45)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-100 bg-linear-to-r from-indigo-50 via-blue-50/65 to-white px-4 py-4 dark:border-indigo-300/20 dark:from-[#202b52] dark:via-[#172447] dark:to-[#111b31] sm:px-5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">
              <Layers className="h-5 w-5" aria-hidden="true" />
            </span>
            <h3 className="text-base font-bold tracking-tight sm:text-lg">Bale Reference Details</h3>
            {baleInfo && <BaleStatusBadge status={baleInfo.status} />}
          </div>
          {model.isAdmin && model.canChangeExistingRecords && (
            <div className="flex flex-wrap items-center gap-2">
              {(baleInfo?.status === "DELETED" || baleInfo?.status === "REMOVED") && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 rounded-lg border-blue-300/60 bg-white/70 font-medium dark:border-blue-400/30 dark:bg-slate-950/30"
                  disabled={model.restoreDeletedMutation.isPending}
                  onClick={() => model.setShowRestoreDeletedDialog(true)}
                  data-testid="button-restore-deleted"
                >
                  <ArchiveRestore className="h-3.5 w-3.5 mr-1" />
                  {model.restoreDeletedMutation.isPending ? "Restoring…" : "Restore to Stock"}
                </Button>
              )}
              {(baleInfo?.status === "RESERVED_FOR_ORDER" ||
                baleInfo?.status === "RESERVED" ||
                baleInfo?.status === "SOLD") && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 rounded-lg border-amber-400/60 bg-amber-50/70 font-medium hover:bg-amber-100 dark:border-amber-500/50 dark:bg-amber-500/10 dark:hover:bg-amber-500/20"
                  onClick={openSwap}
                  data-testid="button-swap-bale"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5 mr-1 text-amber-500" />
                  Swap Bale
                </Button>
              )}
              {baleInfo && canReturnToStock && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 rounded-lg border-blue-400/50 bg-blue-50/60 font-medium hover:bg-blue-100 dark:border-blue-400/50 dark:bg-blue-500/10 dark:hover:bg-blue-500/20"
                  onClick={() => model.setShowReturnToStockDialog(true)}
                  data-testid="button-return-to-stock"
                >
                  <Undo2 className="h-3.5 w-3.5 mr-1 text-blue-500" />
                  Return to Stock
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-9 rounded-lg border-slate-300 bg-white/70 font-medium dark:border-slate-500/50 dark:bg-slate-900/50"
                onClick={openProductChange}
                data-testid="button-change-product"
              >
                <Pencil className="h-3.5 w-3.5 mr-1" />
                Change Product
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-9 rounded-lg font-semibold shadow-sm shadow-red-500/15"
                onClick={() => model.setShowDeleteDialog(true)}
                data-testid="button-delete-bale-everywhere"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Delete Bale
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-4 p-3 sm:p-5">
          <div className="grid grid-cols-2 gap-4 rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 shadow-inner shadow-slate-100 dark:border-slate-600/30 dark:bg-slate-900/60 dark:shadow-none lg:grid-cols-4 lg:gap-5 lg:p-5">
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500 dark:text-slate-400">
                Reference Number
              </p>
              <p
                className="break-all font-mono text-lg font-extrabold tracking-tight text-slate-900 dark:text-slate-50 sm:text-xl"
                data-testid="text-reference-number"
              >
                {labelPrint.referenceNumber}
              </p>
            </div>
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500 dark:text-slate-400">
                Article Code
              </p>
              <p
                className="break-all font-mono text-base font-bold text-slate-900 dark:text-slate-50"
                data-testid="text-ref-article-code"
              >
                {labelPrint.articleCode || "—"}
              </p>
              <p
                className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1"
                data-testid="text-ref-printed-at"
              >
                <Clock className="h-3 w-3" />
                {model.formatDateOnly(labelPrint.printedAt) ?? "N/A"}
              </p>
            </div>
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500 dark:text-slate-400">
                Product Name
              </p>
              <p
                className="font-bold leading-snug text-slate-900 dark:text-slate-50"
                data-testid="text-bale-product-name"
              >
                {baleInfo?.productName || result.product?.name || "—"}
              </p>
              <p
                className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1"
                data-testid="text-ref-printed-by"
              >
                <User className="h-3 w-3" />
                {labelPrint.printedByName || labelPrint.printedByUserId || "Unknown"}
              </p>
            </div>
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500 dark:text-slate-400">
                Pieces
              </p>
              <p
                className="font-mono text-xl font-bold text-slate-900 dark:text-slate-50"
                data-testid="text-ref-pieces"
              >
                {labelPrint.pieces ?? 1}
              </p>
            </div>
            {baleInfo?.workerName && (
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500 dark:text-slate-400">
                  Worker
                </p>
                <p className="flex items-center gap-1 font-semibold" data-testid="text-bale-worker-name">
                  <User className="h-3.5 w-3.5 text-muted-foreground" />
                  {baleInfo.workerName}
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-5 rounded-xl border border-slate-200/80 bg-white p-4 dark:border-slate-600/30 dark:bg-slate-900/35 sm:gap-8">
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500 dark:text-slate-400">
                {baleInfo ? "Actual Weight" : "Approx. Weight"}
              </p>
              {baleInfo && model.canChangeExistingRecords ? (
                <button
                  className="group flex items-center gap-2 rounded-md text-left transition-colors hover:text-blue-600 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:text-blue-300"
                  onClick={() =>
                    model.setWeightEditBale({
                      id: baleInfo.id,
                      referenceNumber: labelPrint.referenceNumber,
                      weightKg: baleInfo.weightKg,
                    })
                  }
                  title="Correct weight"
                >
                  <span className="font-mono text-xl font-extrabold tracking-tight">
                    {model.smartNum(baleInfo.weightKg)} KG
                  </span>
                  <Pencil className="h-3.5 w-3.5 opacity-0 group-hover:opacity-60 shrink-0" />
                </button>
              ) : (
                <span className="font-mono text-xl font-extrabold tracking-tight">
                  {model.smartNum(baleInfo ? baleInfo.weightKg : labelPrint.approxWeightKg)} KG
                </span>
              )}
            </div>
            {baleInfo?.grade && (
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500 dark:text-slate-400">
                  Grade
                </p>
                <p className="font-semibold">{baleInfo.grade}</p>
              </div>
            )}
            {!baleInfo && (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                No linked bale record — showing label-print details only.
              </div>
            )}
            {labelPrint.scannedAt ? (
              <div className="ml-auto flex items-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                Scanned {model.formatDateOnly(labelPrint.scannedAt)}
              </div>
            ) : model.canChangeExistingRecords ? (
              <div className="ml-auto">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-10 rounded-lg border-blue-400/50 bg-blue-50/80 px-4 font-semibold text-blue-700 hover:bg-blue-100 dark:border-blue-400/40 dark:bg-blue-500/15 dark:text-blue-200 dark:hover:bg-blue-500/25"
                  disabled={model.markScanned.isPending}
                  onClick={() => model.markScanned.mutate(labelPrint.referenceNumber)}
                  data-testid="button-mark-scanned"
                >
                  {model.markScanned.isPending ? "Scanning..." : "Mark as Scanned"}
                </Button>
              </div>
            ) : null}
          </div>

          {baleInfo && (
            <div className="flex flex-wrap items-start gap-x-8 gap-y-3 rounded-xl border border-indigo-100/70 bg-indigo-50/40 p-4 dark:border-indigo-300/15 dark:bg-indigo-400/5">
              {(baleInfo.stockEntryDate || baleInfo.finalizedAt) && (
                <InfoRow
                  label="Date Produced"
                  value={model.formatDateOnly(baleInfo.stockEntryDate || baleInfo.finalizedAt) || "—"}
                />
              )}
              {baleInfo.createdAt && (
                <InfoRow label="Record Created" value={model.formatDate(baleInfo.createdAt) || "—"} />
              )}
              {baleInfo.updatedAt && baleInfo.updatedAt !== baleInfo.createdAt && (
                <InfoRow label="Last Modified" value={model.formatDate(baleInfo.updatedAt) || "—"} />
              )}
              {(baleInfo.deletedAt || baleInfo.status === "DELETED") &&
                (() => {
                  const deleteEntry = result.auditHistory.find((entry) => entry.action === "delete");
                  return (
                    <div>
                      <p className="text-xs text-destructive flex items-center gap-1 mb-0.5">
                        <Trash2 className="h-3 w-3" /> Deleted
                      </p>
                      <p className="text-sm font-medium text-destructive">
                        {model.formatDate(baleInfo.deletedAt || deleteEntry?.createdAt) || "—"}
                      </p>
                      {deleteEntry?.username && (
                        <p className="text-xs text-muted-foreground mt-0.5">by {deleteEntry.username}</p>
                      )}
                    </div>
                  );
                })()}
            </div>
          )}
        </div>
      </section>

      {result.auditHistory.length > 0 && (
        <div className="rounded-xl border overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
            <History className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold text-sm">Change Log</span>
          </div>
          <div className="px-4 divide-y">
            {result.auditHistory.map((entry) => {
              const changedFields = entry.changes ? Object.keys(entry.changes) : [];
              const actionLabel =
                entry.action === "create"
                  ? "Created"
                  : entry.action === "delete"
                    ? "Deleted"
                    : entry.action === "restore"
                      ? "Restored"
                      : "Updated";
              return (
                <div key={entry.id} className="flex items-start gap-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge
                        variant={
                          entry.action === "delete"
                            ? "destructive"
                            : entry.action === "create"
                              ? "default"
                              : "secondary"
                        }
                        className="text-xs"
                      >
                        {actionLabel}
                      </Badge>
                      <span className="text-sm font-medium flex items-center gap-1">
                        <User className="h-3 w-3 text-muted-foreground" />
                        {entry.username}
                      </span>
                      <span className="text-xs text-muted-foreground">{model.formatDate(entry.createdAt)}</span>
                    </div>
                    {changedFields.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1 truncate">Changed: {changedFields.join(", ")}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {result.loadedOnOrder && <LoadedOrderCard model={model} />}
      {result.containers_used.length > 0 && <SourceContainersCard model={model} />}
      {result.mixBatch && <MixBatchCard model={model} />}
      {result.pressingBatch && <PressingBatchCard model={model} />}
      {result.product && <LinkedProductCard model={model} />}
    </div>
  );
}
