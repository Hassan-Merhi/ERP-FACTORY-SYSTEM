import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequestPrivileged, queryClient } from "@/lib/queryClient";
import { invalidateApiFamily } from "@/lib/frontendDataArchitecture";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { intercompanyVoucherDetailPath } from "./intercompanyTransferPolicy";
import { useCompany } from "@/contexts/CompanyContext";

type PaymentHistory = {
  id: number;
  status: string;
  paymentDate: string;
  transferReference: string;
  currency: string;
  nativeAmount: string;
  baseAmount: string;
  credit: string;
  sourceVoucherId: number;
  destinationVoucherId: number;
};
const BASE = "/api/intercompany-container-trading/payments";
const makeKey = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `ic-reversal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const today = () => new Date().toLocaleDateString("en-CA");

/** History and coordinated reversal stay accessible inside the normal voucher.
 * No separate intercompany payment form/tab can create a second cash movement.
 */
export default function IntercompanyVoucherHistory({
  relationshipId,
  companyId,
  sourceCompanyId,
  destinationCompanyId,
}: {
  relationshipId: number;
  companyId: number;
  sourceCompanyId: number;
  destinationCompanyId: number;
}) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [reversingId, setReversingId] = useState<number | null>(null);
  const [postingDate, setPostingDate] = useState(today);
  const [reason, setReason] = useState("");
  const [sourceReversed, setSourceReversed] = useState(false);
  const [destReversed, setDestReversed] = useState(false);
  const [requestKey, setRequestKey] = useState(makeKey);
  useEffect(() => {
    setExpanded(false);
    setReversingId(null);
    setReason("");
    setSourceReversed(false);
    setDestReversed(false);
    setRequestKey(makeKey());
  }, [companyId, relationshipId]);

  const history = useQuery<{ relationshipId: number; history: PaymentHistory[] }>({
    queryKey: companyQueryKey(`${BASE}/pairs/${relationshipId}/history`, companyId),
    queryFn: async () => {
      const response = await fetch(`${BASE}/pairs/${relationshipId}/history`, { credentials: "include" });
      const payload = await response.json().catch(() => ({ message: "Cannot load linked payment history" }));
      if (!response.ok) throw new Error(payload.message || "Cannot load linked payment history");
      return payload;
    },
    enabled: expanded && companyId > 0 && relationshipId > 0,
    retry: false,
  });
  const reverse = useMutation({
    mutationFn: async () => {
      if (reversingId == null || !sourceReversed || !destReversed || reason.trim().length < 3) {
        throw new Error("Confirm both real cash reversals and document the reason.");
      }
      const result = await apiRequestPrivileged("POST", `${BASE}/${reversingId}/reverse`, {
        requestKey,
        reversalDate: postingDate,
        reason: reason.trim(),
        confirmedSourceReversal: true,
        confirmedDestinationReversal: true,
      });
      return result.json();
    },
    onSuccess: async () => {
      toast({ title: "Both linked payment vouchers reversed together" });
      setReversingId(null);
      setReason("");
      setSourceReversed(false);
      setDestReversed(false);
      setRequestKey(makeKey());
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: companyQueryKey(`${BASE}/pairs/${relationshipId}/history`, companyId),
        }),
        ...[
          "/api/vouchers",
          "/api/accounts",
          "/api/ledger-accounts",
          "/api/suppliers",
          "/api/daybook",
          "/api/bank-accounts",
          "/api/net-position",
        ].map((key) => invalidateApiFamily(queryClient, key)),
      ]);
    },
    onError: (error: Error) =>
      toast({
        title: "Paired reversal not posted",
        description: error.message,
        variant: "destructive",
      }),
  });
  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="normal-intercompany-history">
      <Button type="button" variant="outline" size="sm" onClick={() => setExpanded(!expanded)}>
        {expanded ? "Hide" : "View"} linked payment history and reversals
      </Button>
      {expanded && (
        <div className="space-y-3">
          {history.isLoading && <p className="text-sm text-muted-foreground">Loading linked vouchers…</p>}
          {history.isError && (
            <p role="alert" className="text-sm text-destructive">
              {history.error.message}
            </p>
          )}
          {history.data?.history.length === 0 && (
            <p className="text-sm text-muted-foreground">No linked payments recorded for this company pair.</p>
          )}
          {history.data?.history.map((entry) => {
            const href = intercompanyVoucherDetailPath(
              selectedCompany?.companyType ?? "",
              sourceCompanyId,
              destinationCompanyId,
              companyId,
              entry.sourceVoucherId,
              entry.destinationVoucherId
            );
            return (
              <div
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm"
              >
                <span>
                  {entry.paymentDate} · {entry.transferReference} · {entry.nativeAmount} {entry.currency}
                  {" · "}
                  {entry.status} · Remaining credit: {entry.credit} USD
                </span>
                <div className="flex gap-2">
                  {href && (
                    <Link href={href} className="text-primary underline">
                      Open voucher
                    </Link>
                  )}
                  {entry.status === "confirmed" && (
                    <Button
                      variant="outline"
                      type="button"
                      size="sm"
                      onClick={() => {
                        setReversingId(entry.id);
                        setReason("");
                        setSourceReversed(false);
                        setDestReversed(false);
                        setRequestKey(makeKey());
                      }}
                    >
                      Reverse both
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          {reversingId != null && (
            <div className="space-y-2 rounded-md border p-3" data-testid="normal-intercompany-reversal">
              <p className="text-sm font-medium">Reverse payment #{reversingId} in both company ledgers</p>
              <p className="text-xs text-muted-foreground">
                Original vouchers remain in history. Posted PO allocations return to unpaid balances.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="ic-normal-reversal-date">Reversal date</Label>
                  <Input
                    id="ic-normal-reversal-date"
                    type="date"
                    value={postingDate}
                    onChange={(event) => setPostingDate(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ic-normal-reversal-reason">Reversal reason</Label>
                  <Input
                    id="ic-normal-reversal-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
              </div>
              <Label className="flex items-center gap-2">
                <Checkbox checked={sourceReversed} onCheckedChange={(checked) => setSourceReversed(checked === true)} />
                Properties receipt actually reversed
              </Label>
              <Label className="flex items-center gap-2">
                <Checkbox checked={destReversed} onCheckedChange={(checked) => setDestReversed(checked === true)} />
                Destination ERP payment actually reversed
              </Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={reverse.isPending || !sourceReversed || !destReversed || reason.trim().length < 3}
                  onClick={() => reverse.mutate()}
                >
                  Post coordinated reversal
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={reverse.isPending}
                  onClick={() => setReversingId(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
