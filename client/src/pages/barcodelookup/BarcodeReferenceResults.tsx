import {
  AlertTriangle,
  ArchiveRestore,
  ArrowLeftRight,
  CheckCircle2,
  Clock,
  Container,
  FileText,
  FlaskConical,
  Hash,
  History,
  Layers,
  Package,
  Pencil,
  Ship,
  Trash2,
  Truck,
  Undo2,
  User,
  User2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BaleStatusBadge } from "./components/BaleStatusBadge";
import { InfoRow } from "./components/InfoRow";
import type { useBarcodeLookupModel } from "./useBarcodeLookupModel";

type BarcodeLookupModel = ReturnType<typeof useBarcodeLookupModel>;

export function BarcodeReferenceResults({ model }: { model: BarcodeLookupModel }) {
  const result = model.referenceResult;
  if (!result) return null;

  if (!result.labelPrint) {
    return (
      <div className="rounded-xl border p-8 text-center text-muted-foreground">
        <Hash className="h-10 w-10 mx-auto mb-3 opacity-25" />
        <p className="text-sm">
          No record found for reference "<span className="font-mono">{model.searchValue}</span>"
        </p>
      </div>
    );
  }

  const { labelPrint, baleInfo } = result;
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
    <div className="space-y-4">
      <div className="rounded-xl border overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-muted/20 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Hash className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="font-bold">Bale Reference Details</span>
            {baleInfo && <BaleStatusBadge status={baleInfo.status} />}
          </div>
          {model.isAdmin && (
            <div className="flex items-center gap-2 flex-wrap">
              {(baleInfo?.status === "DELETED" || baleInfo?.status === "REMOVED") && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={model.restoreDeletedMutation.isPending}
                  onClick={() => baleInfo && model.restoreDeletedMutation.mutate(baleInfo.id)}
                  data-testid="button-restore-deleted"
                >
                  <ArchiveRestore className="h-3.5 w-3.5 mr-1" />
                  {model.restoreDeletedMutation.isPending ? "Restoring…" : "Restore to Stock"}
                </Button>
              )}
              {(baleInfo?.status === "RESERVED_FOR_ORDER" ||
                baleInfo?.status === "RESERVED" ||
                baleInfo?.status === "SOLD") && (
                <>
                  <Button size="sm" variant="outline" onClick={openSwap} data-testid="button-swap-bale">
                    <ArrowLeftRight className="h-3.5 w-3.5 mr-1 text-amber-500" />
                    Swap Bale
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => model.setShowReturnToStockDialog(true)}
                    data-testid="button-return-to-stock"
                  >
                    <Undo2 className="h-3.5 w-3.5 mr-1 text-blue-500" />
                    Return to Stock
                  </Button>
                </>
              )}
              <Button size="sm" variant="outline" onClick={openProductChange} data-testid="button-change-product">
                <Pencil className="h-3.5 w-3.5 mr-1" />
                Change Product
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => model.setShowDeleteDialog(true)}
                data-testid="button-delete-bale-everywhere"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Delete Bale
              </Button>
            </div>
          )}
        </div>

        <div className="px-4 py-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Reference Number</p>
              <p className="font-mono text-lg font-bold" data-testid="text-reference-number">
                {labelPrint.referenceNumber}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Article Code</p>
              <p className="font-mono font-semibold" data-testid="text-ref-article-code">
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
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Product Name</p>
              <p className="font-semibold" data-testid="text-bale-product-name">
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
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Pieces</p>
              <p className="font-mono font-semibold" data-testid="text-ref-pieces">
                {labelPrint.pieces ?? 1}
              </p>
            </div>
            {baleInfo?.workerName && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Worker</p>
                <p className="font-semibold flex items-center gap-1" data-testid="text-bale-worker-name">
                  <User className="h-3.5 w-3.5 text-muted-foreground" />
                  {baleInfo.workerName}
                </p>
              </div>
            )}
          </div>

          <div className="flex items-center gap-6 flex-wrap">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">
                {baleInfo ? "Actual Weight" : "Approx. Weight"}
              </p>
              {baleInfo ? (
                <button
                  className="group flex items-center gap-1.5 hover:text-foreground"
                  onClick={() =>
                    model.setWeightEditBale({
                      id: baleInfo.id,
                      referenceNumber: labelPrint.referenceNumber,
                      weightKg: baleInfo.weightKg,
                    })
                  }
                  title="Correct weight"
                >
                  <span className="font-bold font-mono text-base">{model.smartNum(baleInfo.weightKg)} KG</span>
                  <Pencil className="h-3.5 w-3.5 opacity-0 group-hover:opacity-60 shrink-0" />
                </button>
              ) : (
                <span className="font-bold font-mono text-base">{model.smartNum(labelPrint.approxWeightKg)} KG</span>
              )}
            </div>
            {baleInfo?.grade && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Grade</p>
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
              <div className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                Scanned {model.formatDateOnly(labelPrint.scannedAt)}
              </div>
            ) : (
              <div className="ml-auto">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={model.markScanned.isPending}
                  onClick={() => model.markScanned.mutate(labelPrint.referenceNumber)}
                  data-testid="button-mark-scanned"
                >
                  {model.markScanned.isPending ? "Scanning..." : "Mark as Scanned"}
                </Button>
              </div>
            )}
          </div>

          {baleInfo && (
            <div className="flex items-start gap-6 flex-wrap pt-3 border-t">
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
      </div>

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

function LoadedOrderCard({ model }: { model: BarcodeLookupModel }) {
  const order = model.referenceResult?.loadedOnOrder;
  if (!order) return null;
  const statusColors: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
    FINALIZED: "default",
    VERIFIED: "default",
    PENDING_VERIFICATION: "secondary",
    LOADING: "secondary",
    DRAFT: "outline",
    CANCELLED: "destructive",
  };
  return (
    <div className="rounded-xl border overflow-hidden" data-testid="card-loaded-on-order">
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20 flex-wrap">
        <Ship className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="font-semibold text-sm">Loaded onto Outbound Container</span>
        <Badge variant={statusColors[order.status] ?? "outline"} className="text-xs">
          {order.status.replace("_", " ")}
        </Badge>
      </div>
      <div className="px-4 py-4 grid grid-cols-2 md:grid-cols-3 gap-4">
        {order.containerNumber && (
          <div className="col-span-2 md:col-span-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5 flex items-center gap-1">
              <Truck className="h-3 w-3" /> Container No.
            </p>
            <p className="font-mono font-bold text-base" data-testid="text-loaded-container">
              {order.containerNumber}
            </p>
          </div>
        )}
        {order.customerName && (
          <InfoRow
            label="Customer"
            value={
              <span className="flex items-center gap-1">
                <User2 className="h-3.5 w-3.5 text-muted-foreground" />
                {order.customerName}
              </span>
            }
          />
        )}
        {order.invoiceNumber && (
          <InfoRow
            label="Invoice No."
            value={
              <span className="flex items-center gap-1">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-mono font-semibold">{order.invoiceNumber}</span>
              </span>
            }
          />
        )}
        <InfoRow label="Order Date" value={model.formatDateOnly(order.orderDate)} />
        {order.shippingCompany && <InfoRow label="Shipping Company" value={order.shippingCompany} />}
        <InfoRow label="Total Bales in Order" value={order.totalQtyBales.toLocaleString()} />
        <InfoRow label="This Bale — Weight" value={`${model.smartNum(order.baleWeight)} KG`} />
        {order.loadingStartedAt && <InfoRow label="Loading Started" value={model.formatDate(order.loadingStartedAt)} />}
        {order.loadingFinalizedAt && (
          <InfoRow label="Loading Finalized" value={model.formatDate(order.loadingFinalizedAt)} />
        )}
        {order.scannedBy && (
          <InfoRow
            label="Scanned by"
            value={
              <span className="flex items-center gap-1">
                <User2 className="h-3.5 w-3.5 text-muted-foreground" />
                {order.scannedBy}
              </span>
            }
          />
        )}
        {order.containerNotes && (
          <div className="col-span-2 md:col-span-3">
            <InfoRow label="Notes" value={order.containerNotes} />
          </div>
        )}
      </div>
    </div>
  );
}

function SourceContainersCard({ model }: { model: BarcodeLookupModel }) {
  const containers = model.referenceResult?.containers_used ?? [];
  return (
    <div className="rounded-xl border overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
        <Container className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold text-sm">Source Container{containers.length > 1 ? "s" : ""}</span>
      </div>
      <div className="px-4 py-4 space-y-3">
        {containers.map((container) => (
          <div key={container.id} className="rounded-lg border p-3" data-testid={`card-container-${container.id}`}>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="col-span-2 md:col-span-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5 flex items-center gap-1">
                  <Truck className="h-3 w-3" /> Container No.
                </p>
                <p className="font-mono font-bold text-base" data-testid={`text-container-number-${container.id}`}>
                  {container.containerNumber}
                </p>
              </div>
              {container.supplierName && <InfoRow label="Supplier" value={container.supplierName} />}
              {container.origin && <InfoRow label="Origin" value={container.origin} />}
              {container.arrivalDate && (
                <InfoRow label="Arrival Date" value={model.formatDateOnly(container.arrivalDate)} />
              )}
              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <Badge variant="outline" className="text-xs">
                  {container.status}
                </Badge>
              </div>
              {container.weightKgUsed && (
                <InfoRow label="KG Used" value={`${model.smartNum(container.weightKgUsed)} KG`} />
              )}
              {model.isAdmin && container.ratePerKg && (
                <InfoRow label="Rate / KG" value={`${container.currencyCode} ${model.smartNum(container.ratePerKg)}`} />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MixBatchCard({ model }: { model: BarcodeLookupModel }) {
  const batch = model.referenceResult?.mixBatch;
  if (!batch) return null;
  return (
    <div className="rounded-xl border overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
        <FlaskConical className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold text-sm">Mix Batch</span>
      </div>
      <div className="px-4 py-4 grid grid-cols-2 md:grid-cols-3 gap-4">
        <InfoRow label="Batch Code" value={<span className="font-mono font-semibold">{batch.batchCode}</span>} />
        {batch.batchNumber && <InfoRow label="Batch Number" value={batch.batchNumber} />}
        {batch.name && <InfoRow label="Name" value={batch.name} />}
        {batch.batchDate && <InfoRow label="Batch Date" value={model.formatDateOnly(batch.batchDate)} />}
        <InfoRow label="Total Weight" value={`${model.smartNum(batch.totalWeightKg)} KG`} />
        {model.isAdmin && <InfoRow label="Cost / KG" value={model.smartNum(batch.costPerKg)} />}
        <div>
          <p className="text-sm text-muted-foreground">Status</p>
          <Badge variant="outline" className="text-xs">
            {batch.status}
          </Badge>
        </div>
        {batch.operatorUser && <InfoRow label="Operator" value={batch.operatorUser} />}
      </div>
    </div>
  );
}

function PressingBatchCard({ model }: { model: BarcodeLookupModel }) {
  const batch = model.referenceResult?.pressingBatch;
  if (!batch) return null;
  return (
    <div className="rounded-xl border overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
        <Layers className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold text-sm">Pressing Batch</span>
      </div>
      <div className="px-4 py-4 grid grid-cols-2 md:grid-cols-3 gap-4">
        <InfoRow label="Batch ID" value={<span className="font-mono font-semibold">#{batch.id}</span>} />
        <div>
          <p className="text-sm text-muted-foreground">Status</p>
          <Badge variant="outline" className="text-xs">
            {batch.status}
          </Badge>
        </div>
        <InfoRow label="Expected Bale Count" value={batch.expectedCount} />
        {batch.finalizedAt && <InfoRow label="Finalized At" value={model.formatDate(batch.finalizedAt)} />}
        {batch.notes && (
          <div className="col-span-2 md:col-span-3">
            <InfoRow label="Notes" value={batch.notes} />
          </div>
        )}
      </div>
    </div>
  );
}

function LinkedProductCard({ model }: { model: BarcodeLookupModel }) {
  const product = model.referenceResult?.product;
  if (!product) return null;
  return (
    <div className="rounded-xl border overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
        <Package className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold text-sm">Linked Product</span>
      </div>
      <div className="px-4 py-4 grid grid-cols-2 md:grid-cols-3 gap-4">
        <InfoRow
          label="Article Code"
          value={<span className="font-mono font-semibold">{product.articleCode || product.code}</span>}
        />
        <InfoRow label="Product Name" value={product.name} />
        <div>
          <p className="text-sm text-muted-foreground">Status</p>
          <Badge variant={product.active ? "default" : "secondary"} className="text-xs">
            {product.active ? "Active" : "Inactive"}
          </Badge>
        </div>
      </div>
    </div>
  );
}
