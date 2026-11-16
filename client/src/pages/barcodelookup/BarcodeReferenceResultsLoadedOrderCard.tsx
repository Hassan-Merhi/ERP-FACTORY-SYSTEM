// Extracted from ./BarcodeReferenceResults.tsx to keep that module under the source-size cap.
import { Container, FileText, FlaskConical, Layers, Package, Ship, Truck, User2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InfoRow } from "./components/InfoRow";
import type { useBarcodeLookupModel } from "./useBarcodeLookupModel";

export type BarcodeLookupModel = ReturnType<typeof useBarcodeLookupModel>;

export function LoadedOrderCard({ model }: { model: BarcodeLookupModel }) {
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
        <InfoRow
          label="Destination"
          value={<span className="whitespace-pre-wrap break-words">{order.destination?.trim() || "—"}</span>}
        />
        {order.canViewBookingInfo && (
          <InfoRow
            label="Booking Info"
            value={<span className="whitespace-pre-wrap break-words">{order.bookingInfo?.trim() || "—"}</span>}
          />
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

export function SourceContainersCard({ model }: { model: BarcodeLookupModel }) {
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

export function MixBatchCard({ model }: { model: BarcodeLookupModel }) {
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

export function PressingBatchCard({ model }: { model: BarcodeLookupModel }) {
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

export function LinkedProductCard({ model }: { model: BarcodeLookupModel }) {
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
