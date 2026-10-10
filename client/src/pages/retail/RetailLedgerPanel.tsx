import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { readJson } from "@/pages/pos/retailPosTypes";

interface AccountOption {
  id: number;
  code: string;
  name: string;
}

interface CashReason {
  reasonCode: string;
  label: string | null;
  direction: "cash_in" | "cash_out" | "either";
  ledgerAccountId: number | null;
  bankAccountId: number | null;
  source: "mapping" | "default" | "none";
}

interface OpeningPlan {
  openingDate: string;
  subLedgerValue: string;
  ledgerBalance: string;
  amount: string;
  stockRows: number;
  laterDocuments: number;
  alreadyApplied: { openingDate: string; voucherId: number | null } | null;
  blockers: string[];
  planHash: string;
}

interface InventoryReconciliation {
  applicable: boolean;
  opening: { openingDate: string; voucherId: number | null } | null;
  ledger: string;
  subLedger: string;
  difference: string;
}

const targetValue = (reason: { ledgerAccountId: number | null; bankAccountId: number | null }) =>
  reason.bankAccountId
    ? `bank:${reason.bankAccountId}`
    : reason.ledgerAccountId
      ? `ledger:${reason.ledgerAccountId}`
      : "";

/**
 * Wave 17 (D): the account each cash movement reason posts to, the Retail
 * inventory opening (Owner preview/apply) and RETAIL-INVENTORY against the
 * Retail stock sub-ledger.
 */
export function RetailLedgerPanel({
  companyKey,
  ledgers,
  banks,
}: {
  companyKey: number;
  ledgers: AccountOption[];
  banks: AccountOption[];
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [openingDate, setOpeningDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [plan, setPlan] = useState<OpeningPlan | null>(null);

  const reasonsQuery = useQuery<{ reasons: CashReason[] }>({
    queryKey: ["retail-cash-reasons", companyKey],
    queryFn: () => readJson("/api/retail/financial/cash-reasons"),
  });
  useEffect(() => {
    if (reasonsQuery.data) {
      setDraft(Object.fromEntries(reasonsQuery.data.reasons.map((reason) => [reason.reasonCode, targetValue(reason)])));
    }
  }, [reasonsQuery.data]);

  const reconciliationQuery = useQuery<InventoryReconciliation>({
    queryKey: ["retail-inventory-reconciliation", companyKey],
    queryFn: () => readJson("/api/retail/financial/inventory-reconciliation"),
    staleTime: 15_000,
  });

  const saveReasons = useMutation({
    mutationFn: async () => {
      const reasons = Object.entries(draft).map(([reasonCode, value]) => {
        const [kind, id] = value.split(":");
        return {
          reasonCode,
          ledgerAccountId: kind === "ledger" ? Number(id) : null,
          bankAccountId: kind === "bank" ? Number(id) : null,
        };
      });
      return (await apiRequest("PUT", "/api/retail/financial/cash-reasons", { reasons })).json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["retail-cash-reasons"] });
      toast({ title: "Cash movement accounts saved" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not save cash movement accounts", description: error.message, variant: "destructive" }),
  });

  const preview = useMutation({
    mutationFn: async () =>
      readJson<OpeningPlan>(
        `/api/retail/financial/inventory-opening/preview?openingDate=${encodeURIComponent(openingDate)}`
      ),
    onSuccess: (result) => setPlan(result),
    onError: (error: Error) =>
      toast({ title: "Could not preview the opening", description: error.message, variant: "destructive" }),
  });

  const apply = useMutation({
    mutationFn: async () => {
      if (!plan) throw new Error("Preview the opening first");
      return (
        await apiRequest("POST", "/api/retail/financial/inventory-opening/apply", {
          openingDate: plan.openingDate,
          planHash: plan.planHash,
          confirm: true,
        })
      ).json();
    },
    onSuccess: async () => {
      setPlan(null);
      await queryClient.invalidateQueries({ queryKey: ["retail-inventory-reconciliation"] });
      toast({ title: "Retail inventory opening applied" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not apply the opening", description: error.message, variant: "destructive" }),
  });

  const reconciliation = reconciliationQuery.data;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cash movement accounts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(reasonsQuery.data?.reasons ?? []).map((reason) => (
            <div key={reason.reasonCode}>
              <Label className="text-xs">
                {reason.label ?? reason.reasonCode} ({reason.direction.replace("_", " ")})
              </Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={draft[reason.reasonCode] ?? ""}
                onChange={(event) => setDraft((current) => ({ ...current, [reason.reasonCode]: event.target.value }))}
              >
                <option value="">No account (movements refused)</option>
                {ledgers.map((account) => (
                  <option key={`ledger:${account.id}`} value={`ledger:${account.id}`}>
                    {account.code} · {account.name}
                  </option>
                ))}
                {banks.map((account) => (
                  <option key={`bank:${account.id}`} value={`bank:${account.id}`}>
                    Bank · {account.code} · {account.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <Button disabled={saveReasons.isPending || !reasonsQuery.data} onClick={() => saveReasons.mutate()}>
            <Save className="mr-2 h-4 w-4" /> Save cash movement accounts
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Retail inventory in the ledger</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {reconciliation ? (
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">Ledger</div>
                <strong>{reconciliation.ledger}</strong>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">Stock sub-ledger</div>
                <strong>{reconciliation.subLedger}</strong>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">Difference</div>
                <strong className={reconciliation.difference !== "0.00" ? "text-destructive" : ""}>
                  {reconciliation.difference}
                </strong>
              </div>
            </div>
          ) : null}
          {reconciliation?.opening ? (
            <div>Opening applied on {reconciliation.opening.openingDate}.</div>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                <Input type="date" value={openingDate} onChange={(event) => setOpeningDate(event.target.value)} />
                <Button variant="outline" disabled={preview.isPending} onClick={() => preview.mutate()}>
                  Preview opening
                </Button>
                <Button disabled={!plan || plan.blockers.length > 0 || apply.isPending} onClick={() => apply.mutate()}>
                  Apply opening
                </Button>
              </div>
              {plan ? (
                <div className="rounded-md border p-2 text-xs">
                  Stock {plan.subLedgerValue} ({plan.stockRows} rows) · ledger {plan.ledgerBalance} · opening journal{" "}
                  {plan.amount}
                  {plan.blockers.length ? <div className="text-destructive">{plan.blockers.join(", ")}</div> : null}
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
