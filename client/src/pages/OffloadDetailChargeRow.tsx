// Extracted from ./OffloadDetail.tsx to keep that module under the source-size cap.
import { Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { format } from "date-fns";

export function formatAmount(value: number) {
  if (isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number) {
  if (isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDisplayDate(date: Date) {
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
  returnedQty?: string;
  netQty?: string;
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

export interface OffloadDetailData {
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
  netTotalBales?: string;
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
          className="text-amber-600 border-amber-500 bg-amber-500/10 gap-1 ml-2 text-[11px] px-1 py-0"
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

export function ChargeRow({
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
