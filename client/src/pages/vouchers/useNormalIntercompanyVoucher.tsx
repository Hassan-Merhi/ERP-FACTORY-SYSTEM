import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useApplicationLanguageCode } from "@/contexts/ApplicationLanguageContext";
import { intercompanyVoucherText } from "@/i18n/intercompanyVoucherTranslations";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type VoucherFormData } from "./voucherTypes";
import IntercompanyVoucherHistory from "./IntercompanyVoucherHistory";

const PREVIEW = "/api/intercompany-container-trading/payments/voucher-preview";

type CashAccount = { id: number; companyId: number; type: "cash" | "bank"; name: string };
type PurchaseOrder = { tradeId: number; version: number; containerNumber: string; unpaid: string };
type VoucherMirrorMatch = {
  relationshipId: number;
  sourceCompanyId: number;
  destinationCompanyId: number;
  role: "source-receipt" | "destination-payment";
};
type Preview =
  | { matched: false }
  | {
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
  const copy = intercompanyVoucherText(useApplicationLanguageCode());
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
  const shouldCheck =
    enabled &&
    companyId > 0 &&
    paymentAccountId > 0 &&
    accountKeys.some((row) => row.accountId > 0 && ["ledger", "supplier"].includes(row.accountType));
  const previewQuery = useQuery<Preview>({
    queryKey: [PREVIEW, companyId, voucherType, paymentAccountType, paymentAccountId, signature],
    enabled: shouldCheck,
    retry: false,
    queryFn: async () => {
      const response = await apiRequest("POST", PREVIEW, {
        voucherType,
        paymentAccountType,
        paymentAccountId,
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
  const defaultCounterpart =
    optionsForOtherCompany.length === 1 ? `${optionsForOtherCompany[0].type}:${optionsForOtherCompany[0].id}` : "";
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
      throw new Error(
        "Choose the linked company's bank/cash account, add actual transfer proof and confirm both movements."
      );
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
      return (
        <p className="text-sm text-muted-foreground" data-testid="ic-normal-checking">
          {copy.linkedChecking}
        </p>
      );
    }
    if (previewQuery.isError) {
      return (
        <p role="alert" className="text-sm text-destructive" data-testid="ic-normal-error">
          {previewQuery.error.message}
        </p>
      );
    }
    if (!match) return null;
    return (
      <div className="space-y-3 rounded-lg border p-4" data-testid="normal-voucher-intercompany">
        <div className="space-y-1">
          <h3 className="font-semibold">{copy.linkedDetected}</h3>
          <p className="text-sm text-muted-foreground">
            {voucherType === "Payment" ? copy.linkedPaymentInfo : copy.linkedReceiptInfo}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="ic-normal-counterpart">{copy.linkedCounterpart}</Label>
            <select
              id="ic-normal-counterpart"
              value={selection}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              onChange={(event) => setCounterpart(event.target.value)}
            >
              <option value="">{copy.linkedSelectCash}</option>
              {optionsForOtherCompany.map((account) => (
                <option key={`${account.type}:${account.id}`} value={`${account.type}:${account.id}`}>
                  {account.name} ({account.type})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ic-normal-ref">{copy.linkedReference}</Label>
            <Input
              id="ic-normal-ref"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder={copy.linkedReference}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ic-normal-evidence">{copy.linkedEvidence}</Label>
            <Input
              id="ic-normal-evidence"
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
              placeholder={copy.linkedEvidence}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ic-normal-reason">{copy.linkedReason}</Label>
            <Input
              id="ic-normal-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={copy.linkedReason}
            />
          </div>
        </div>
        {(match.purchaseOrders ?? []).length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{copy.linkedAllocation}</p>
            <p className="text-xs text-muted-foreground">{copy.linkedCredit}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {match.purchaseOrders.map((po) => (
                <Label key={po.tradeId} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {po.containerNumber} ({copy.linkedDue} {po.unpaid})
                  </span>
                  <Input
                    aria-label={`Allocate to PO ${po.containerNumber}`}
                    className="max-w-32"
                    value={allocations[po.tradeId] ?? ""}
                    onChange={(event) =>
                      setAllocations((current) => ({
                        ...current,
                        [po.tradeId]: event.target.value,
                      }))
                    }
                    placeholder="0.00"
                  />
                </Label>
              ))}
            </div>
          </div>
        )}
        <Label className="flex items-center gap-2 font-normal">
          <Checkbox checked={confirmed} onCheckedChange={(checked) => setConfirmed(checked === true)} />
          {copy.linkedConfirm}
        </Label>
        <IntercompanyVoucherHistory
          relationshipId={match.match.relationshipId}
          companyId={companyId}
          sourceCompanyId={match.match.sourceCompanyId}
          destinationCompanyId={match.match.destinationCompanyId}
        />
      </div>
    );
  };

  return { match, previewQuery, buildMirror, details: Details() };
}
