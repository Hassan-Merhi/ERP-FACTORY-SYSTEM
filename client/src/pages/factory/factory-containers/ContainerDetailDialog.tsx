import { useQuery } from "@tanstack/react-query";
import { Container, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { factoryApiRequest } from "@/lib/factoryApi";
import { formatNumber } from "@/lib/formatNumber";
import { getContainerStatusLabel } from "./otwHelpers";
import type { ContainerWithSupplier } from "./otwHelpers";
import type { ApiListRow } from "@shared/apiTypes";

interface ContainerOtherChargeRow {
  id: number;
  amount: string | null;
  currencyCode: string | null;
  ledgerAccountId: number | null;
  description: string | null;
}

interface ContainerDetailDialogProps {
  container: ContainerWithSupplier | null;
  suppliers: NoInfer<{ address: string | null; id: number; name: string; email: string | null; createdAt: Date; companyId: number; phone: string | null; notes: string | null; updatedAt: Date; parentId: number | null; openingBalance: string; isActive: boolean; contactPerson: string | null; linkedSupplierId: number | null; supplierCategoryId: number | null; isBroker: boolean; currentRawMaterialCostPerKgUsd: string | null; }[]> | undefined;
  ledgerAccounts: ApiListRow[];
  onClose: () => void;
  onEdit: (c: ContainerWithSupplier) => void;
}

export function ContainerDetailDialog({
  container,
  suppliers,
  ledgerAccounts,
  onClose,
  onEdit,
}: ContainerDetailDialogProps) {
  const { data: viewContainerCharges = [] } = useQuery<ContainerOtherChargeRow[]>({
    queryKey: ["/api/factory/containers", container?.id, "other-charges"],
    queryFn: async () => {
      if (!container) return [];
      const res = await factoryApiRequest("GET", `/api/factory/containers/${container.id}/other-charges`);
      return res.ok ? res.json() : [];
    },
    enabled: !!container,
  });

  if (!container) return null;

  const vc = container;
  const ccy = vc.currencyCode || "USD";
  const totalKg = parseFloat(vc.totalKg || "0");
  const ratePerKg = parseFloat(vc.ratePerKg || "0");
  const baseValue = totalKg * ratePerKg;
  const freightAmt = parseFloat(vc.freight || "0");
  const freightCcy = vc.freightCurrencyCode || ccy;
  const commAmt = parseFloat(vc.commissionAmount || "0");
  const commCcy = vc.commissionCurrencyCode || "USD";
  const brokerSupId = vc.commissionSupplierId;
  const brokerName = brokerSupId ? (suppliers?.find((s) => s.id === brokerSupId)?.name ?? null) : null;
  const freightAccName = vc.freightAccountId
    ? (ledgerAccounts.find((a) => a.id === vc.freightAccountId)?.name ?? `Account #${vc.freightAccountId}`)
    : null;
  const commAccName = vc.commissionAccountId
    ? (ledgerAccounts.find((a) => a.id === vc.commissionAccountId)?.name ?? `Account #${vc.commissionAccountId}`)
    : null;
  const legacyOtherAmt = parseFloat(vc.otherCharges || "0");
  const legacyOtherAccName = vc.otherChargesAccountId
    ? (ledgerAccounts.find((a) => a.id === vc.otherChargesAccountId)?.name ?? `Account #${vc.otherChargesAccountId}`)
    : null;
  const fxRate = parseFloat(vc.fxRateToUsd || "1");

  return (
    <Dialog
      open={!!container}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono">
            <Container className="h-5 w-5" />
            {container.containerNumber}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 pt-1">
            <Badge variant={container.status === "OFFLOADED" ? "default" : "secondary"}>
              {getContainerStatusLabel(container.status)}
            </Badge>
            {container.supplierName && <span className="text-muted-foreground">{container.supplierName}</span>}
            {container.arrivalDate && <span className="text-muted-foreground">· Arrived {container.arrivalDate}</span>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Goods</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <span className="text-muted-foreground">Weight</span>
              <span className="font-mono text-right">{formatNumber(totalKg)} kg</span>
              <span className="text-muted-foreground">Rate</span>
              <span className="font-mono text-right">
                {ccy} {formatNumber(ratePerKg)} / kg
              </span>
              {ccy !== "USD" && fxRate !== 1 && (
                <>
                  <span className="text-muted-foreground">FX Rate</span>
                  <span className="font-mono text-right">
                    1 {ccy} = {fxRate} USD
                  </span>
                </>
              )}
              <span className="text-muted-foreground font-medium">Base Value</span>
              <span className="font-mono font-semibold text-right">
                {ccy} {formatNumber(baseValue)}
              </span>
            </div>
          </div>
          <Separator />
          {freightAmt > 0 && (
            <>
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Freight</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <span className="text-muted-foreground">Amount</span>
                  <span className="font-mono text-right">
                    {freightCcy} {formatNumber(freightAmt)}
                  </span>
                  {freightAccName && (
                    <>
                      <span className="text-muted-foreground">Account</span>
                      <span className="text-right truncate">{freightAccName}</span>
                    </>
                  )}
                </div>
              </div>
              <Separator />
            </>
          )}
          {(legacyOtherAmt > 0 || viewContainerCharges.length > 0) && (
            <>
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Other Charges</p>
                <div className="space-y-2">
                  {legacyOtherAmt > 0 && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                      <span className="text-muted-foreground">Other Charges (legacy)</span>
                      <span className="font-mono text-right">
                        {ccy} {formatNumber(legacyOtherAmt)}
                      </span>
                      {legacyOtherAccName && (
                        <>
                          <span className="text-muted-foreground">Account</span>
                          <span className="text-right truncate">{legacyOtherAccName}</span>
                        </>
                      )}
                    </div>
                  )}
                  {viewContainerCharges.map((ch) => {
                    const accName = ch.ledgerAccountId
                      ? (ledgerAccounts.find((a) => a.id === ch.ledgerAccountId)?.name ??
                        `Account #${ch.ledgerAccountId}`)
                      : null;
                    return (
                      <div key={ch.id} className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                        <span className="text-muted-foreground">{ch.description || "Charge"}</span>
                        <span className="font-mono text-right">
                          {ch.currencyCode || ccy} {formatNumber(parseFloat(ch.amount || "0"))}
                        </span>
                        {accName && (
                          <>
                            <span className="text-muted-foreground pl-3">↳ Account</span>
                            <span className="text-right truncate text-xs text-muted-foreground">{accName}</span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <Separator />
            </>
          )}
          {commAmt > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Commission</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-mono text-right">
                  {commCcy} {formatNumber(commAmt)}
                </span>
                {brokerName && (
                  <>
                    <span className="text-muted-foreground">Broker</span>
                    <span className="text-right">{brokerName}</span>
                  </>
                )}
                {commAccName && (
                  <>
                    <span className="text-muted-foreground">Account</span>
                    <span className="text-right truncate">{commAccName}</span>
                  </>
                )}
                {vc.commissionNotes && (
                  <>
                    <span className="text-muted-foreground">Notes</span>
                    <span className="text-right">{vc.commissionNotes}</span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              onClose();
              onEdit(container);
            }}
          >
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
