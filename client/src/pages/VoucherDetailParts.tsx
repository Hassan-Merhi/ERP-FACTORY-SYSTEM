// Extracted from ./VoucherDetail.tsx
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface VoucherItem {
  id: number;
  stockItemId: number | null;
  stockItemName: string;
  stockItemCode: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
}

interface VoucherEntry {
  id: number;
  ledgerAccountId: number;
  ledgerAccountName: string;
  debitAmount: number;
  creditAmount: number;
  narration: string | null;
}

export interface VoucherDetailData {
  id: number;
  voucherNumber: string;
  voucherType: string;
  date: string;
  partyName: string | null;
  purchaseLedger: string | null;
  locationName: string | null;
  narration: string | null;
  supplierInvoiceNo: string | null;

  items: VoucherItem[];
  entries: VoucherEntry[];

  totals: {
    quantity: number;
    amount: number;
    debit: number;
    credit: number;
  };
}

interface ICStatus {
  id: number;
  status: string;
  destCompanyName: string;
  amount: string;
  approvedByUsername: string | null;
  approvedAt: string | null;
  destVoucherId: number | null;
  dismissNote: string | null;
}

export function IntercompanyStatusPanel({ voucherId }: { voucherId: number }) {
  const { data: statuses = [] } = useQuery<ICStatus[]>({
    queryKey: ["/api/vouchers", voucherId, "intercompany-status"],
    queryFn: async () => {
      const r = await fetch(`/api/vouchers/${voucherId}/intercompany-status`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!voucherId,
  });

  if (statuses.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ArrowRight className="h-4 w-4" />
          Intercompany Notifications
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {statuses.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">{s.destCompanyName}</span>
            {s.status === "approved" && (
              <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 text-xs">Approved</Badge>
            )}
            {s.status === "dismissed" && (
              <Badge className="bg-rose-500/10 text-rose-600 border-rose-500/30 text-xs">Dismissed</Badge>
            )}
            {s.status === "pending" && (
              <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/30 text-xs">Pending approval</Badge>
            )}
            {s.approvedByUsername && <span className="text-muted-foreground text-xs">by {s.approvedByUsername}</span>}
            {s.destVoucherId && (
              <span className="text-xs text-muted-foreground">· Mirror voucher #{s.destVoucherId}</span>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export const voucherTypeColors: Record<string, string> = {
  Payment: "bg-red-500",
  Receipt: "bg-green-500",
  Journal: "bg-blue-500",
  "Stock Transfer": "bg-purple-500",
  Production: "bg-orange-500",
  Consumption: "bg-yellow-500",
  "Purchase Import": "bg-indigo-500",
};
