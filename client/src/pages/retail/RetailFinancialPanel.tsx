import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { readJson, type Location } from "@/pages/pos/retailPosTypes";
import { RetailLedgerPanel } from "./RetailLedgerPanel";

interface AccountOption {
  id: number;
  code: string;
  name: string;
  accountType?: string;
}

interface FinancialAccounts {
  ledgers: AccountOption[];
  banks: AccountOption[];
}

interface RetailAccountingSettings {
  id: number;
  companyId: number;
  locationId: number | null;
  cashLedgerAccountId: number;
  cardLedgerAccountId: number;
  bankLedgerAccountId: number;
  bankAccountId: number | null;
  mobileLedgerAccountId: number;
  otherLedgerAccountId: number;
  salesRevenueLedgerAccountId: number;
  inventoryAssetLedgerAccountId: number;
  cogsLedgerAccountId: number;
  discountsLedgerAccountId: number;
  taxPayableLedgerAccountId: number;
  storeCreditLedgerAccountId: number;
}

interface ReconciliationRow {
  sale_id: number;
  status: string;
  totalAmount: number;
  payments: number;
  refunds: number;
  accounting_voucher_id: number | null;
  paymentMismatch: boolean;
  accountingMissing: boolean;
  created_at: string;
}

interface Reconciliation {
  rows: ReconciliationRow[];
  summary: {
    sales: number;
    paymentMismatches: number;
    missingAccounting: number;
  };
}

const LABELS: Array<[keyof RetailAccountingSettings, string]> = [
  ["cashLedgerAccountId", "Cash"],
  ["cardLedgerAccountId", "Card clearing"],
  ["bankLedgerAccountId", "Bank clearing"],
  ["mobileLedgerAccountId", "Mobile payment clearing"],
  ["otherLedgerAccountId", "Other payment clearing"],
  ["salesRevenueLedgerAccountId", "Retail sales revenue"],
  ["inventoryAssetLedgerAccountId", "Retail inventory asset"],
  ["cogsLedgerAccountId", "Retail COGS"],
  ["discountsLedgerAccountId", "Discounts"],
  ["taxPayableLedgerAccountId", "Tax payable"],
  ["storeCreditLedgerAccountId", "Store credit liability"],
];

export function RetailFinancialPanel({ companyKey }: { companyKey: number }) {
  const { toast } = useToast();
  const [locationId, setLocationId] = useState("");
  const [draft, setDraft] = useState<RetailAccountingSettings | null>(null);

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["retail-financial-locations", companyKey],
    queryFn: () => readJson("/api/locations"),
  });
  const { data: accounts } = useQuery<FinancialAccounts>({
    queryKey: ["retail-financial-accounts", companyKey],
    queryFn: () => readJson("/api/retail/financial/accounts"),
  });
  const settingsUrl = useMemo(
    () => `/api/retail/financial/settings${locationId ? `?locationId=${locationId}` : ""}`,
    [locationId]
  );
  const settingsQuery = useQuery<RetailAccountingSettings>({
    queryKey: ["retail-financial-settings", companyKey, locationId],
    queryFn: () => readJson(settingsUrl),
  });
  useEffect(() => {
    if (settingsQuery.data) setDraft(settingsQuery.data);
  }, [settingsQuery.data]);

  const reconciliationUrl = useMemo(
    () => `/api/retail/financial/reconciliation${locationId ? `?locationId=${locationId}` : ""}`,
    [locationId]
  );
  const reconciliationQuery = useQuery<Reconciliation>({
    queryKey: ["retail-financial-reconciliation", companyKey, locationId],
    queryFn: () => readJson(reconciliationUrl),
    staleTime: 15_000,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Retail accounting settings are not loaded");
      const response = await apiRequest("PUT", "/api/retail/financial/settings", {
        ...draft,
        locationId: locationId ? Number(locationId) : null,
      });
      return response.json();
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["retail-financial-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-financial-reconciliation"] }),
      ]);
      toast({ title: "Retail accounting settings saved" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not save Retail accounting", description: error.message, variant: "destructive" }),
  });

  const summary = reconciliationQuery.data?.summary;
  const problems = (reconciliationQuery.data?.rows ?? []).filter((row) => row.paymentMismatch || row.accountingMissing);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Retail accounting mapping</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>Scope</Label>
              <select
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">Company default</option>
                {locations
                  .filter((location) => location.id > 0)
                  .map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
              </select>
            </div>
            {draft && accounts ? (
              <div className="grid gap-2 md:grid-cols-2">
                {LABELS.map(([key, label]) => (
                  <div key={key}>
                    <Label className="text-xs">{label}</Label>
                    <select
                      className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={String(draft[key] ?? "")}
                      onChange={(event) =>
                        setDraft((current) => (current ? { ...current, [key]: Number(event.target.value) } : current))
                      }
                    >
                      {accounts.ledgers.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} · {account.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                <div>
                  <Label className="text-xs">Bank account (optional)</Label>
                  <select
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={draft.bankAccountId ?? ""}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, bankAccountId: event.target.value ? Number(event.target.value) : null }
                          : current
                      )
                    }
                  >
                    <option value="">Use bank clearing ledger</option>
                    {accounts.banks.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} · {account.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Loading accounting mapping…</div>
            )}
            <Button disabled={!draft || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
              <Save className="mr-2 h-4 w-4" /> Save mapping
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Retail financial reconciliation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {summary ? (
              <>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div className="rounded-md border p-2">
                    <div className="text-xs text-muted-foreground">Sales checked</div>
                    <strong>{summary.sales}</strong>
                  </div>
                  <div className="rounded-md border p-2">
                    <div className="text-xs text-muted-foreground">Payment mismatches</div>
                    <strong className={summary.paymentMismatches ? "text-destructive" : ""}>
                      {summary.paymentMismatches}
                    </strong>
                  </div>
                  <div className="rounded-md border p-2">
                    <div className="text-xs text-muted-foreground">Missing accounting</div>
                    <strong className={summary.missingAccounting ? "text-destructive" : ""}>
                      {summary.missingAccounting}
                    </strong>
                  </div>
                </div>
                {!problems.length ? (
                  <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
                    <CheckCircle2 className="h-4 w-4" /> Retail sales, payments and accounting are reconciled.
                  </div>
                ) : (
                  <div className="max-h-64 space-y-2 overflow-y-auto">
                    {problems.slice(0, 50).map((row) => (
                      <div key={row.sale_id} className="rounded-md border border-destructive/30 p-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <strong className="flex items-center gap-1">
                            <AlertTriangle className="h-4 w-4 text-destructive" /> Sale #{row.sale_id}
                          </strong>
                          <span>{new Date(row.created_at).toLocaleString()}</span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Sale {row.totalAmount.toFixed(2)} · Paid {row.payments.toFixed(2)} · Refunds{" "}
                          {row.refunds.toFixed(2)}
                          {row.accountingMissing ? " · accounting missing" : ""}
                          {row.paymentMismatch ? " · payment mismatch" : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm text-muted-foreground">Loading reconciliation…</div>
            )}
          </CardContent>
        </Card>
      </div>
      {accounts ? (
        <RetailLedgerPanel companyKey={companyKey} ledgers={accounts.ledgers} banks={accounts.banks} />
      ) : null}
    </div>
  );
}
