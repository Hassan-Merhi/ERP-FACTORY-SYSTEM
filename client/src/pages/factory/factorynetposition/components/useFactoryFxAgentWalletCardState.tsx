// Extracted from ./FactoryFxAgentWalletCard.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirmAction } from "@/components/ConfirmHost";

type Choice = { id: number; name: string; code?: string; accountType?: string };

type Wallet = {
  wallet: { id: number; ledgerAccountId: number; accountName: string; accountCode: string };
  state: { usd: string; eur: string; eurBookUsd: string; totalBookUsd: string };
  ledgerBookUsd: string;
  bookDifferenceUsd: string;
  hasOperations: boolean;
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

export const fmt = (v: string | number) =>
  Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function useFactoryFxAgentWalletCardState({
  asOf,
  readOnly,
  scopeAccountId,
}: {
  asOf: string;
  readOnly: boolean;
  scopeAccountId?: number;
}) {
  const { toast } = useToast();
  const { data: user } = useQuery(authenticatedUserQueryOptions());
  // The company role must also allow changes: View Only and Create Only never post FX agent transactions.
  const recordChanges = useExistingRecordChangeAccess();
  const canEdit = ["Admin", "Owner", "Developer"].includes(user?.role || "") && !readOnly && recordChanges.allowed;
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
  const [rebaselineReason, setRebaselineReason] = useState("");
  const [open, setOpen] = useState(Boolean(scopeAccountId));

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
  const visibleWallets = (data?.wallets || []).filter(
    (w) => scopeAccountId == null || w.wallet.ledgerAccountId === scopeAccountId
  );
  const active = visibleWallets.find((w) => String(w.wallet.id) === walletId) || visibleWallets[0];
  const choices = useMemo(
    () =>
      (data?.candidates || [])
        .filter(
          (a) =>
            (scopeAccountId == null || a.id === scopeAccountId) &&
            (a.name + " " + (a.code || "")).toLowerCase().includes(accountSearch.toLowerCase())
        )
        .slice(0, 100),
    [data?.candidates, accountSearch, scopeAccountId]
  );
  const { data: reversalHistory } = useQuery<{
    migrationRequired: boolean;
    conversions: Array<{
      id: number;
      date: string;
      usdAmount: string;
      eurAmount: string;
      rate: string;
      actor: string | null;
      reversed: boolean;
      hasLaterSettlement: boolean;
    }>;
  }>({
    queryKey: ["/api/factory/fx-agent-wallets", active?.wallet.id, "conversions"],
    enabled: Boolean(active) && open,
    queryFn: async () => {
      const res = await fetch("/api/factory/fx-agent-wallets/" + active!.wallet.id + "/conversions", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });
  const [reversalReason, setReversalReason] = useState("");
  const write = useMutation({
    mutationFn: async ({ path, body }: WalletWrite) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return (await apiRequest("POST", path, body)).json();
    },
    onSuccess: () => {
      toast({ title: "FX agent transaction saved" });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/fx-agent-wallets"] });
      setReversalReason("");
      setRebaselineReason("");
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
  return {
    accountId,
    accountSearch,
    active,
    canEdit,
    choices,
    convertRate,
    data,
    error,
    eurAmount,
    isLoading,
    notes,
    open,
    rebaselineReason,
    reversalHistory,
    reversalReason,
    scopeAccountId,
    setAccountId,
    setAccountSearch,
    setConvertRate,
    setEurAmount,
    setNotes,
    setOpen,
    setRebaselineReason,
    setReversalReason,
    setSettleRate,
    setTargetId,
    setTargetKind,
    setUsdAmount,
    setWalletId,
    settleRate,
    targetId,
    targetKind,
    usdAmount,
    visibleWallets,
    write,
  };
}

export function FactoryFxAgentWalletCardSection({
  accountId,
  accountSearch,
  choices,
  scopeAccountId,
  setAccountId,
  setAccountSearch,
  write,
}: Pick<
  ReturnType<typeof useFactoryFxAgentWalletCardState>,
  "accountId" | "accountSearch" | "choices" | "scopeAccountId" | "setAccountId" | "setAccountSearch" | "write"
>) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold">Link an existing FX agent ledger account</h4>
      {scopeAccountId == null && (
        <Input
          placeholder="Search account name or code"
          value={accountSearch}
          onChange={(e) => setAccountSearch(e.target.value)}
        />
      )}
      <select
        className="w-full h-10 border rounded-md bg-background px-2 text-sm"
        value={scopeAccountId == null ? accountId : String(scopeAccountId)}
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
        disabled={write.isPending || !(scopeAccountId || Number(accountId))}
        variant="secondary"
        size="sm"
        onClick={async () => {
          if (
            await confirmAction({
              title: "Activate FX wallet?",
              description:
                "Confirm this account represents USD funds held by the FX agent. A EUR wallet will be activated using its existing posted USD balance. This does not change old vouchers.",
              confirmText: "Activate",
              tone: "warning",
            })
          ) {
            write.mutate({
              path: "/api/factory/fx-agent-wallets",
              body: { ledgerAccountId: scopeAccountId ?? Number(accountId), confirmUsdSource: true },
            });
          }
        }}
      >
        Activate FX wallet
      </Button>
    </section>
  );
}
