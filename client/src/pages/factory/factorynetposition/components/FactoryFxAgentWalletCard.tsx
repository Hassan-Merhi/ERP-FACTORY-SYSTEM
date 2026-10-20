import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Choice = { id: number; name: string; code?: string; accountType?: string };
type Wallet = {
  wallet: { id: number; ledgerAccountId: number; accountName: string; accountCode: string };
  state: { usd: string; eur: string; eurBookUsd: string; totalBookUsd: string };
  ledgerBookUsd: string;
  synchronized: boolean;
  currentUsd: string | null;
  currentRateUsdPerEur: string | null;
};
type WalletResponse = {
  setupRequired: boolean;
  asOf?: string;
  currentRate?: string | null;
  wallets: Wallet[];
  candidates: Choice[];
  factorySuppliers?: Choice[];
};
type WalletWrite = { path: string; body: Record<string, unknown> };
const fmt = (v: string | number) =>
  Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function FactoryFxAgentWalletCard({ asOf, readOnly }: { asOf: string; readOnly: boolean }) {
  const { toast } = useToast();
  const { data: user } = useQuery(authenticatedUserQueryOptions());
  const canEdit = ["Admin", "Owner", "Developer"].includes(user?.role || "") && !readOnly;
  const [accountId, setAccountId] = useState("");
  const [accountSearch, setAccountSearch] = useState("");
  const [walletId, setWalletId] = useState("");
  const [usdAmount, setUsdAmount] = useState("");
  const [eurAmount, setEurAmount] = useState("");
  const [convertRate, setConvertRate] = useState("");
  const [settleRate, setSettleRate] = useState("");
  const [targetKind, setTargetKind] = useState<"factorySupplier" | "ledger">("factorySupplier");
  const [targetId, setTargetId] = useState("");
  const [notes, setNotes] = useState("");
  const [open, setOpen] = useState(false);

  const { data, isLoading, error } = useQuery<WalletResponse>({
    queryKey: ["/api/factory/fx-agent-wallets", asOf],
    queryFn: async () => {
      const response = await fetch("/api/factory/fx-agent-wallets?asOf=" + encodeURIComponent(asOf), {
        credentials: "include",
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    staleTime: 30_000,
  });
  const active = data?.wallets.find((w) => String(w.wallet.id) === walletId) || data?.wallets[0];
  const choices = useMemo(
    () =>
      (data?.candidates || [])
        .filter((a) => (a.name + " " + (a.code || "")).toLowerCase().includes(accountSearch.toLowerCase()))
        .slice(0, 100),
    [data?.candidates, accountSearch]
  );
  const write = useMutation({
    mutationFn: async ({ path, body }: WalletWrite) => (await apiRequest("POST", path, body)).json(),
    onSuccess: () => {
      toast({ title: "FX agent transaction saved" });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/fx-agent-wallets"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/net-position"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers/with-balances"] });
      setUsdAmount("");
      setEurAmount("");
    },
    onError: (err: Error) =>
      toast({ title: "FX transaction refused", description: err.message, variant: "destructive" }),
  });

  if (error) return <p className="text-sm text-destructive">FX agent account data could not be loaded.</p>;
  return (
    <Card data-testid="factory-fx-agent-wallets">
      <CardHeader className="pb-3">
        <div className="flex justify-between items-center gap-2">
          <div>
            <CardTitle className="text-base">FX Agent Accounts (USD / EUR)</CardTitle>
            <CardDescription>
              Native EUR held by an agent; Net Position values it at the dated Settings rate.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Manage"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <p className="text-sm text-muted-foreground">Loading agent balances…</p>}
        {data?.setupRequired && (
          <p className="text-sm text-destructive">
            The reviewed FX-agent wallet SQL migration must be applied before this can be used.
          </p>
        )}
        {!data?.setupRequired &&
          data?.wallets.map((w) => (
            <div
              key={w.wallet.id}
              className="border rounded-md px-3 py-2 flex flex-wrap items-center justify-between gap-2"
            >
              <div className="text-sm font-medium">
                {w.wallet.accountName} <span className="text-muted-foreground">({w.wallet.accountCode})</span>
              </div>
              <div className="flex flex-wrap gap-4 text-sm font-mono">
                <span>USD {fmt(w.state.usd)}</span>
                <span>EUR {fmt(w.state.eur)}</span>
                <span>≈ USD {w.currentUsd == null ? "Rate required" : fmt(w.currentUsd)}</span>
                {!w.synchronized && <span className="text-destructive">Ledger mismatch — blocked</span>}
              </div>
            </div>
          ))}
        {open && !data?.setupRequired && (
          <div className="space-y-4 border-t pt-4">
            {canEdit && (
              <section className="space-y-2">
                <h4 className="text-sm font-semibold">Link an existing FX agent ledger account</h4>
                <Input
                  placeholder="Search account name or code"
                  value={accountSearch}
                  onChange={(e) => setAccountSearch(e.target.value)}
                />
                <select
                  className="w-full h-10 border rounded-md bg-background px-2 text-sm"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  <option value="">Choose a ledger account</option>
                  {choices.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.code})
                    </option>
                  ))}
                </select>
                <Button
                  disabled={write.isPending || !accountId}
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Confirm this account represents USD funds held by the FX agent. Activate a EUR wallet using its existing posted USD balance? This does not change old vouchers."
                      )
                    ) {
                      write.mutate({
                        path: "/api/factory/fx-agent-wallets",
                        body: { ledgerAccountId: Number(accountId), confirmUsdSource: true },
                      });
                    }
                  }}
                >
                  Activate FX wallet
                </Button>
              </section>
            )}
            {!!data?.wallets.length && (
              <section className="space-y-2">
                <h4 className="text-sm font-semibold">Choose agent</h4>
                <select
                  className="w-full h-10 border rounded-md bg-background px-2 text-sm"
                  value={active?.wallet.id || ""}
                  onChange={(e) => setWalletId(e.target.value)}
                >
                  {data.wallets.map((w) => (
                    <option key={w.wallet.id} value={w.wallet.id}>
                      {w.wallet.accountName}
                    </option>
                  ))}
                </select>
                {!!active && (
                  <p className="text-xs text-muted-foreground">
                    EUR available: {fmt(active.state.eur)}. Historical USD basis: {fmt(active.state.eurBookUsd)}.
                    Settings EUR rate: {active.currentRateUsdPerEur || "Not set"}.
                  </p>
                )}
              </section>
            )}
            {canEdit && active?.synchronized && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <section className="space-y-2 border rounded-lg p-3">
                  <h4 className="text-sm font-semibold">Convert agent USD balance to EUR</h4>
                  <label className="text-xs" htmlFor="fx-agent-usd">
                    USD to convert
                  </label>
                  <Input
                    id="fx-agent-usd"
                    type="number"
                    min="0"
                    step="0.01"
                    value={usdAmount}
                    onChange={(e) => setUsdAmount(e.target.value)}
                  />
                  <label className="text-xs" htmlFor="fx-agent-convert-rate">
                    Agreed rate: USD per 1 EUR
                  </label>
                  <Input
                    id="fx-agent-convert-rate"
                    type="number"
                    min="0"
                    step="any"
                    placeholder="e.g. 1.1115"
                    value={convertRate}
                    onChange={(e) => setConvertRate(e.target.value)}
                  />
                  <p className="text-sm font-mono">
                    {Number(convertRate) > 0 && Number(usdAmount) > 0
                      ? "EUR " + fmt(Number(usdAmount) / Number(convertRate))
                      : "Enter the conversion details"}
                  </p>
                  <Button
                    size="sm"
                    disabled={write.isPending || !(Number(usdAmount) > 0) || !(Number(convertRate) > 0)}
                    onClick={() =>
                      write.mutate({
                        path: "/api/factory/fx-agent-wallets/" + active.wallet.id + "/convert",
                        body: {
                          usdAmount,
                          rateUsdPerEur: convertRate,
                          requestKey: crypto.randomUUID(),
                          narration: notes,
                        },
                      })
                    }
                  >
                    Convert USD → EUR
                  </Button>
                </section>
                <section className="space-y-2 border rounded-lg p-3">
                  <h4 className="text-sm font-semibold">Pay a USD beneficiary from agent EUR</h4>
                  <label className="text-xs" htmlFor="fx-agent-eur">
                    EUR to use
                  </label>
                  <Input
                    id="fx-agent-eur"
                    type="number"
                    min="0"
                    step="0.01"
                    value={eurAmount}
                    onChange={(e) => setEurAmount(e.target.value)}
                  />
                  <label className="text-xs" htmlFor="fx-agent-settle-rate">
                    Agreed payment rate: USD per 1 EUR
                  </label>
                  <Input
                    id="fx-agent-settle-rate"
                    type="number"
                    min="0"
                    step="any"
                    placeholder="e.g. 1.14"
                    value={settleRate}
                    onChange={(e) => setSettleRate(e.target.value)}
                  />
                  <p className="text-sm font-mono">
                    {Number(settleRate) > 0 && Number(eurAmount) > 0
                      ? "Supplier receives USD " + fmt(Number(eurAmount) * Number(settleRate))
                      : "Enter the payment details"}
                  </p>
                  <select
                    className="w-full h-10 border rounded-md bg-background px-2 text-sm"
                    value={targetKind}
                    onChange={(e) => {
                      setTargetKind(e.target.value as "factorySupplier" | "ledger");
                      setTargetId("");
                    }}
                  >
                    <option value="factorySupplier">Factory supplier</option>
                    <option value="ledger">Ledger account</option>
                  </select>
                  <select
                    className="w-full h-10 border rounded-md bg-background px-2 text-sm"
                    value={targetId}
                    onChange={(e) => setTargetId(e.target.value)}
                  >
                    <option value="">Choose USD recipient</option>
                    {(targetKind === "factorySupplier" ? data?.factorySuppliers || [] : data?.candidates || [])
                      .filter((a) => targetKind !== "ledger" || a.id !== active.wallet.ledgerAccountId)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                  <Button
                    size="sm"
                    disabled={
                      write.isPending ||
                      !targetId ||
                      !(Number(eurAmount) > 0) ||
                      Number(eurAmount) > Number(active.state.eur) ||
                      !(Number(settleRate) > 0)
                    }
                    onClick={() => {
                      if (
                        window.confirm(
                          "Pay the selected USD beneficiary using the quoted EUR and exchange rate? This will post a journal."
                        )
                      ) {
                        write.mutate({
                          path: "/api/factory/fx-agent-wallets/" + active.wallet.id + "/settle",
                          body: {
                            eurAmount,
                            rateUsdPerEur: settleRate,
                            targetKind,
                            targetId: Number(targetId),
                            requestKey: crypto.randomUUID(),
                            narration: notes,
                          },
                        });
                      }
                    }}
                  >
                    Post USD payment
                  </Button>
                </section>
              </div>
            )}
            {canEdit && !!active && (
              <Input
                placeholder="Optional transaction narration"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            )}
            {!canEdit && (
              <p className="text-xs text-muted-foreground">
                Read-only: historical mode or role without FX settlement permission.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
