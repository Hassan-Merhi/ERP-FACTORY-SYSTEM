import type { ClientErrorLike } from "@/lib/clientError";
import { useParams, useLocation } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Package, Zap, PauseCircle, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PageHeader } from "@/components/PageHeader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { parseISO, format } from "date-fns";

function formatAmount(value: number) {
  if (isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value: number) {
  if (isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDisplayDate(date: Date) {
  return format(date, "dd MMM yyyy");
}

interface OffloadItem {
  id: number;
  stockItemId: number;
  stockItemName: string | null;
  stockItemCode: string | null;
  quantity: string;
  rate: string;
  totalValue: string;
}

interface PoCharges {
  freight: number;
  surcharge: number;
  fumigation: number;
  documentCharges: number;
  discount: number;
  otherCharges: number;
  total: number;
}

interface AdditionalCharge {
  id: number;
  chargeType: string;
  amount: string;
}

interface LiveCharges {
  duties: number;
  officeCharges: number;
  transportFees: number;
  transferCharges: number;
  additionalCharges: number;
  totalOffloadCharges: number;
  totalAllCharges: number;
  additionalCostPerBale: number;
  hasVouchers: boolean;
}

interface OffloadDetailData {
  id: number;
  containerId: number;
  containerNumber: string;
  locationId: number;
  locationName: string | null;
  duties: string;
  officeCharges: string;
  transferCharges: string;
  transportFees: string;
  totalCharges: string;
  totalBales: string;
  additionalCostPerBale: string;
  offloadedAt: string;
  containerChargesTotal: string;
  optional: boolean;
  companyId: number;
  items: OffloadItem[];
  poCharges: PoCharges;
  additionalCharges: AdditionalCharge[];
  liveCharges?: LiveCharges;
}

function LiveBadge({ original, live }: { original: number; live: number }) {
  const changed = Math.abs(live - original) >= 0.01;
  if (!changed) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="text-amber-600 border-amber-500 bg-amber-500/10 gap-1 ml-2 text-[10px] px-1 py-0"
        >
          <Zap className="w-2.5 h-2.5" />
          updated
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <p>Original at offload: {formatAmount(original)}</p>
        <p>Current from voucher: {formatAmount(live)}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function ChargeRow({
  label,
  original,
  live,
  isSubtotal = false,
  isNegative = false,
  indent = false,
}: {
  label: string;
  original: number;
  live?: number;
  isSubtotal?: boolean;
  isNegative?: boolean;
  indent?: boolean;
}) {
  const displayValue = live !== undefined ? live : original;
  if (displayValue === 0 && (live === undefined || live === 0)) return null;
  return (
    <tr className={isSubtotal ? "border-t bg-muted/20 font-medium" : "border-b"}>
      <td className={`p-3 ${indent ? "pl-5" : ""} flex items-center gap-1`}>
        {label}
        {live !== undefined && <LiveBadge original={original} live={live} />}
      </td>
      <td className={`p-3 text-right font-mono ${isNegative ? "text-red-600 dark:text-red-400" : ""}`}>
        {isNegative ? `-${formatAmount(displayValue)}` : formatAmount(displayValue)}
      </td>
    </tr>
  );
}

export default function OffloadDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const handleBack = useBackToParent();
  useEscapeToParent();
  const id = params.id;
  const { toast } = useToast();

  const {
    data: offload,
    isLoading,
    isError,
    error,
  } = useQuery<OffloadDetailData>({
    queryKey: [`/api/offloads/${id}`],
    enabled: !!id,
  });

  const toggleOptionalMutation = useMutation({
    // The button states its intent (Suspend → optional, Restore → active) rather
    // than asking the server to flip whatever it currently holds. That is what
    // lets a retransmitted click be recognized as the same request: the payload
    // is identical, so the fetch guard reuses one clientRequestId and the server
    // replays the committed outcome instead of toggling back.
    mutationFn: () => apiRequest("POST", `/api/offloads/${id}/toggle-optional`, { optional: !offload?.optional }),
    onSuccess: async (res) => {
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: [`/api/offloads/${id}`] });
      toast({ title: data.optional ? "Offload suspended" : "Offload restored", description: data.message });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const itemsTotal = offload?.items.reduce((s, i) => s + Number(i.totalValue), 0) ?? 0;
  const live = offload?.liveCharges;
  // Prefer live voucher amounts when available
  const displayDuties = live?.hasVouchers ? live.duties : Number(offload?.duties || 0);
  const displayOfficeCharges = live?.hasVouchers ? live.officeCharges : Number(offload?.officeCharges || 0);
  const displayTransportFees = live?.hasVouchers ? live.transportFees : Number(offload?.transportFees || 0);
  const displayTransferCharges = live?.hasVouchers ? live.transferCharges : Number(offload?.transferCharges || 0);
  // containerCharges (Freight, Discount, Document Charges) are always in additionalCharges — add regardless of live vouchers
  const storedAdditionalCharges = (offload?.additionalCharges || []).reduce((s, c) => s + Number(c.amount || 0), 0);
  const displayAddlCharges = live?.hasVouchers ? live.additionalCharges : 0;
  const displayOffloadTotal =
    (live?.hasVouchers
      ? live.totalOffloadCharges
      : displayDuties + displayOfficeCharges + displayTransportFees + displayTransferCharges + displayAddlCharges) +
    storedAdditionalCharges;

  const _displayCostPerBale = live?.hasVouchers
    ? live.additionalCostPerBale
    : Number(offload?.additionalCostPerBale || 0);

  // Stored original values for comparison badges
  const storedDuties = Number(offload?.duties || 0);
  const storedOfficeCharges = Number(offload?.officeCharges || 0);
  const storedTransportFees = Number(offload?.transportFees || 0);
  const storedTransferCharges = Number(offload?.transferCharges || 0);

  const anyVoucherUpdated =
    live?.hasVouchers &&
    (Math.abs(live.duties - storedDuties) >= 0.01 ||
      Math.abs(live.officeCharges - storedOfficeCharges) >= 0.01 ||
      Math.abs(live.transportFees - storedTransportFees) >= 0.01 ||
      Math.abs(live.transferCharges - storedTransferCharges) >= 0.01);

  return (
    <div className="w-full space-y-6 sm:p-8">
      <PageHeader
        title={isLoading ? <Skeleton className="h-7 w-40" /> : offload?.containerNumber}
        onBack={handleBack}
        backButtonTestId="button-back-offload"
        meta={
          <>
            <Badge variant="outline" className="text-amber-600 border-amber-500 bg-amber-500/10 gap-1">
              <Package className="w-3 h-3" />
              Offload
            </Badge>
            {offload?.optional && (
              <Badge variant="outline" className="text-red-600 border-red-500 bg-red-500/10 gap-1">
                <PauseCircle className="w-3 h-3" />
                Suspended
              </Badge>
            )}
            {anyVoucherUpdated && (
              <Badge variant="outline" className="text-amber-600 border-amber-500 bg-amber-500/10 gap-1 text-xs">
                <Zap className="w-3 h-3" />
                Vouchers updated since offload
              </Badge>
            )}
            {offload && (
              <span>
                {formatDisplayDate(parseISO(offload.offloadedAt.slice(0, 10)))}
                {offload.locationName ? ` — ${offload.locationName}` : ""}
              </span>
            )}
          </>
        }
      >
        {offload && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant={offload.optional ? "default" : "outline"}
                className="gap-2"
                data-testid="button-toggle-optional"
                disabled={toggleOptionalMutation.isPending}
              >
                {offload.optional ? (
                  <>
                    <PlayCircle className="w-4 h-4" /> Restore Offload
                  </>
                ) : (
                  <>
                    <PauseCircle className="w-4 h-4" /> Suspend Offload
                  </>
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{offload.optional ? "Restore Offload?" : "Suspend Offload?"}</AlertDialogTitle>
                <AlertDialogDescription>
                  {offload.optional
                    ? `This will re-add all ${formatNumber(Number(offload.totalBales))} bales back into stock at the original rates, and make all related vouchers (duties, transport, office, transfer, additional charges) active again.`
                    : `This will remove all ${formatNumber(Number(offload.totalBales))} bales from stock and mark all related vouchers (duties, transport, office, transfer, additional charges) as optional so they are excluded from financial calculations. You can restore it at any time.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => toggleOptionalMutation.mutate()}
                  className={
                    offload.optional ? "" : "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  }
                >
                  {offload.optional ? "Restore" : "Suspend"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </PageHeader>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : offload ? (
        <>
          {offload.items.length > 0 && (
            <div>
              <p className="text-sm font-medium mb-2 text-muted-foreground uppercase tracking-wide">Stock Items</p>
              <div className="border rounded-md overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-30 bg-muted/50">
                    <tr className="border-b bg-muted/40">
                      <th className="text-left p-3 font-medium">Item</th>
                      <th className="text-right p-3 font-medium">Qty</th>
                      <th className="text-right p-3 font-medium">Rate</th>
                      <th className="text-right p-3 font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {offload.items.map((item) => (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="p-3">
                          {item.stockItemName || item.stockItemCode || `Item #${item.stockItemId}`}
                        </td>
                        <td className="p-3 text-right font-mono">{formatNumber(Number(item.quantity))}</td>
                        <td className="p-3 text-right font-mono">{formatAmount(Number(item.rate))}</td>
                        <td className="p-3 text-right font-mono">{formatAmount(Number(item.totalValue))}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 bg-muted/20 font-medium">
                      <td className="p-3">Total</td>
                      <td className="p-3 text-right font-mono">
                        {formatNumber(offload.items.reduce((s, i) => s + Number(i.quantity), 0))}
                      </td>
                      <td></td>
                      <td className="p-3 text-right font-mono">{formatAmount(itemsTotal)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm mt-3">
                <div>
                  <p className="text-muted-foreground">Total Bales</p>
                  <p className="font-medium font-mono">{formatNumber(Number(offload.totalBales))}</p>
                </div>
              </div>
            </div>
          )}

          {/* Unified Import Charges — all PO freight + landing charges in one table */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Import Charges</p>
              {live?.hasVouchers && (
                <Badge variant="outline" className="text-xs gap-1">
                  <Zap className="w-3 h-3" />
                  Landing charges from live vouchers
                </Badge>
              )}
            </div>
            <div className="border rounded-md overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left p-3 font-medium">Charge</th>
                    <th className="text-right p-3 font-medium w-36">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {/* ── Landing / Local Charges ── */}
                  <tr className="bg-muted/20">
                    <td
                      colSpan={2}
                      className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide"
                    >
                      Landing Charges
                    </td>
                  </tr>
                  {(displayDuties > 0 || storedDuties > 0) && (
                    <ChargeRow
                      label="Duties"
                      original={storedDuties}
                      live={live?.hasVouchers ? live.duties : undefined}
                      indent
                    />
                  )}
                  {(displayOfficeCharges > 0 || storedOfficeCharges > 0) && (
                    <ChargeRow
                      label="Office Charges"
                      original={storedOfficeCharges}
                      live={live?.hasVouchers ? live.officeCharges : undefined}
                      indent
                    />
                  )}
                  {(displayTransferCharges > 0 || storedTransferCharges > 0) && (
                    <ChargeRow
                      label="Transfer Charges"
                      original={storedTransferCharges}
                      live={live?.hasVouchers ? live.transferCharges : undefined}
                      indent
                    />
                  )}
                  {(displayTransportFees > 0 || storedTransportFees > 0) && (
                    <ChargeRow
                      label="Transport Fees"
                      original={storedTransportFees}
                      live={live?.hasVouchers ? live.transportFees : undefined}
                      indent
                    />
                  )}
                  {offload.additionalCharges
                    .filter((c) => Number(c.amount) !== 0)
                    .map((c) => (
                      <tr key={c.id} className="border-b">
                        <td className="p-3 pl-5">{c.chargeType}</td>
                        <td className="p-3 text-right font-mono">{formatAmount(Number(c.amount))}</td>
                      </tr>
                    ))}
                  {displayAddlCharges > 0 && (
                    <tr className="border-b">
                      <td className="p-3 pl-5 flex items-center gap-1">
                        Additional Charges
                        {live?.hasVouchers && (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 gap-0.5">
                            <Zap className="w-2.5 h-2.5" />
                            live
                          </Badge>
                        )}
                      </td>
                      <td className="p-3 text-right font-mono">{formatAmount(displayAddlCharges)}</td>
                    </tr>
                  )}
                  {/* ── Grand Total + Cost/Bale ── */}
                  <tr className="bg-muted/30 font-semibold border-t-2">
                    <td className="p-3">Total Charges</td>
                    <td className="p-3 text-right font-mono">{formatAmount(displayOffloadTotal)}</td>
                  </tr>
                  <tr className="text-muted-foreground">
                    <td className="p-3 text-sm">
                      Cost / Bale&nbsp;
                      <span className="font-mono text-xs text-muted-foreground">
                        ({formatAmount(displayOffloadTotal)} ÷ {formatNumber(Number(offload.totalBales))} bales)
                      </span>
                    </td>
                    <td className="p-3 text-right font-mono font-semibold text-amber-600 dark:text-amber-400">
                      {Number(offload.totalBales) > 0
                        ? formatAmount(Math.round((displayOffloadTotal / Number(offload.totalBales)) * 100) / 100)
                        : formatAmount(0)}{" "}
                      / bale
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="border rounded-md p-4 flex items-center justify-between bg-muted/20">
            <div>
              <p className="text-sm text-muted-foreground">Grand Total (charges included in rates)</p>
              <p className="text-2xl font-semibold font-mono mt-0.5">{formatAmount(itemsTotal)}</p>
            </div>
            <Button
              variant="outline"
              onClick={() => navigate(`/containers/${offload.containerId}`)}
              data-testid="button-goto-container"
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              Open Container
            </Button>
          </div>
        </>
      ) : isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : isError ? (
        <div className="text-center py-12 space-y-2">
          <p className="text-muted-foreground font-medium">Could not load offload #{id}</p>
          <p className="text-sm text-muted-foreground">{error?.message || "Unknown error"}</p>
          <Button variant="outline" className="mt-4" onClick={handleBack}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Go Back
          </Button>
        </div>
      ) : (
        <div className="text-center py-12 space-y-2">
          <p className="text-muted-foreground font-medium">Offload #{id} not found.</p>
          <Button variant="outline" className="mt-4" onClick={handleBack}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Go Back
          </Button>
        </div>
      )}
    </div>
  );
}
