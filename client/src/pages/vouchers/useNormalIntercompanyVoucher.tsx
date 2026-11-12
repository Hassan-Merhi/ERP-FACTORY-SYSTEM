import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest } from "@/lib/queryClient";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type VoucherFormData } from "./voucherTypes";

const PREVIEW = "/api/intercompany-container-trading/payments/voucher-preview";

type CashAccount = { id: number; companyId: number; type: "cash" | "bank"; name: string };
type PurchaseOrder = { tradeId: number; version: number; containerNumber: string; unpaid: string };
type VoucherMirrorMatch = {
  relationshipId: number;
  sourceCompanyId: number;
  destinationCompanyId: number;
  role: "source-receipt" | "destination-payment";
};
type Preview = { matched: false } | {
  matched: true;
  match: VoucherMirrorMatch;
  counterpartCashAccounts: CashAccount[];
  purchaseOrders: PurchaseOrder[];
  creditTotal: Array<{ paymentId: number; available: string }>;
};
export type IntercompanyVoucherMirror = {
  counterpartCashAccount: { type: "cash" | "bank"; id: number };
  transferReference: string;
  confirmationEvidence: string;
  reason: string;
  confirmedBoth: true;
  allocations: Array<{ tradeId: number; expectedVersion: number; amount: string }>;
};

export function useNormalIntercompanyVoucher(options: {
  companyId: number;
  enabled: boolean;
  voucherType: "Payment" | "Receipt";
  paymentAccountType: string;
  paymentAccountId: number;
  entries: VoucherFormData["entries"];
}) {
  const { companyId, voucherType, paymentAccountType, paymentAccountId, entries, enabled } = options;
  const [counterpart, setCounterpart] = useState("");
  const [reference, setReference] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [allocations, setAllocations] = useState<Record<number, string>>({});
  const accountKeys = useMemo(
    () => entries.map((row) => ({ accountType: row.accountType, accountId: row.accountId })),
    [entries]
  );
  const signature = JSON.stringify(accountKeys);
  const shouldCheck = enabled && companyId > 0 && paymentAccountId > 0 &&
    (accountKeys.some((row) => row.accountId > 0 && ["ledger", "supplier"].includes(row.accountType)) ||
     (paymentAccountId > 0 && ["ledger", "supplier"].includes(paymentAccountType)));
  const previewQuery = useQuery<Preview>({
    queryKey: [PREVIEW, companyId, voucherType, paymentAccountType, paymentAccountId, signature],
    enabled: shouldCheck,
    retry: false,
    queryFn: async () => {
      const response = await apiRequest("POST", PREVIEW, {
        voucherType, paymentAccountType, paymentAccountId,
        entries: accountKeys.filter((row) => row.accountId > 0),
      });
      return (await response.json()) as Preview;
    },
    staleTime: 0,
  });
  const match = previewQuery.data?.matched ? previewQuery.data : null;
  const pairKey = match?.match.relationshipId ?? null;
  useEffect(() => {
    setCounterpart("");
    setReference("");
    setEvidence("");
    setReason("");
    setConfirmed(false);
    setAllocations({});
  }, [companyId, voucherType, pairKey]);

  const optionsForOtherCompany = match?.counterpartCashAccounts ?? [];
  const defaultCounterpart = optionsForOtherCompany.length === 1
    ? `${optionsForOtherCompany[0].type}:${optionsForOtherCompany[0].id}` : "";
  const selection = counterpart || defaultCounterpart;
  const selectedCash = optionsForOtherCompany.find((row) => `${row.type}:${row.id}` === selection);
  const allocationRows = (match?.purchaseOrders ?? []).flatMap((po) => {
    const amount = allocations[po.tradeId]?.trim();
    return amount ? [{ tradeId: po.tradeId, expectedVersion: po.version, amount }] : [];
  });

  const buildMirror = (): IntercompanyVoucherMirror | undefined => {
    if (!enabled) return undefined;
    if (shouldCheck && (!previewQuery.data || previewQuery.isError || previewQuery.isFetching)) {
      throw new Error("Verify the linked intercompany account before posting. Both companies must be online.");
    }
    if (!match) return undefined;
    if (!selectedCash || !reference.trim() || !evidence.trim() || !confirmed) {
      throw new Error("Choose the linked company's bank/cash account, add actual transfer proof and confirm both movements.");
    }
    if (reference.trim().length < 5 || evidence.trim().length < 8) {
      throw new Error("The transfer reference must have 5+ characters and the proof must have 8+ characters.");
    }
    if (reason.trim().length < 3) throw new Error("Enter a short transfer reason.");
    return {
      counterpartCashAccount: { type: selectedCash.type, id: selectedCash.id },
      transferReference: reference.trim(),
      confirmationEvidence: evidence.trim(),
      reason: reason.trim(),
      confirmedBoth: true,
      allocations: allocationRows,
    };
  };

  const Details = () => {
    if (!enabled || !shouldCheck) return null;
    if (previewQuery.isPending || previewQuery.isFetching) {
      return <p className="text-sm text-muted-foreground" data-testid="ic-normal-checking">Checking linked accounts…</p>;
    }
    if (previewQuery.isError) {
      return <p role="alert" className="text-sm text-destructive" data-testid="ic-normal-error">{previewQuery.error.message}</p>;
    }
    if (!match) return null;
    return (
      <div className="space-y-3 rounded-lg border p-4" data-testid="normal-voucher-intercompany">
        <div className="space-y-1">
          <h3 className="font-semibold">Linked intercompany account detected</h3>
          <p className="text-sm text-muted-foreground">
            This normal {voucherType} will automatically post the matching
            {voucherType === "Payment" ? " Receipt in Properties" : " Payment in the destination ERP"}.
            It will not also post a standalone voucher.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="ic-normal-counterpart">Linked company's actual bank/cash account</Label>
            <select id="ic-normal-counterpart" value={selection}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              onChange={(event) => setCounterpart(event.target.value)}>
              <option value="">Choose actual bank/cash account</option>
              {optionsForOtherCompany.map((account) => (
                <option key={`${account.type}:${account.id}`} value={`${account.type}:${account.id}`}>
                  {account.name} ({account.type})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ic-normal-ref">Real transfer reference</Label>
            <Input id="ic-normal-ref" value={reference} onChange={(event) => setReference(event.target.value)}
              placeholder="Bank transfer or cash receipt reference" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ic-normal-evidence">Proof both sides moved money</Label>
            <Input id="ic-normal-evidence" value={evidence} onChange={(event) => setEvidence(event.target.value)}
              placeholder="Two bank statement / cash receipt references" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ic-normal-reason">Transfer reason</Label>
            <Input id="ic-normal-reason" value={reason} onChange={(event) => setReason(event.target.value)}
              placeholder="Settlement for intercompany purchases" />
          </div>
        </div>
        {(match.purchaseOrders ?? []).length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Optional allocation to linked POs</p>
            <p className="text-xs text-muted-foreground">Unallocated money remains a credit with the same company pair.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {match.purchaseOrders.map((po) => (
                <Label key={po.tradeId} className="flex items-center justify-between gap-2">
                  <span className="truncate">{po.containerNumber} (due {po.unpaid})</span>
                  <Input aria-label={`Allocate to PO ${po.containerNumber}`} className="max-w-32"
                    value={allocations[po.tradeId] ?? ""}
                    onChange={(event) => setAllocations((current) => ({
                      ...current, [po.tradeId]: event.target.value,
                    }))}
                    placeholder="0.00" />
                </Label>
              ))}
            </div>
          </div>
        )}
        <Label className="flex items-center gap-2 font-normal">
          <Checkbox checked={confirmed} onCheckedChange={(checked) => setConfirmed(checked === true)}/>
          I confirm the actual payment and receipt in both companies, with no duplicate bank/cash movement.
        </Label>
      </div>
    );
  };

  return { match, previewQuery, buildMirror, Details };
}
