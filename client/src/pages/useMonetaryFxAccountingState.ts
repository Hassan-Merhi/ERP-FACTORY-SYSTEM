// Extracted from ./MonetaryFxAccounting.tsx
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Account, Domain, RateMatrix, RealizedList, Valuation } from "./monetaryFxAccountingTypes";
import { load } from "./MonetaryFxAccountingHelpers";

export function useMonetaryFxAccountingState() {
  const [location] = useLocation();
  const factory = location.startsWith("/factory/");
  const properties = location.startsWith("/properties/");
  const voucher = (id: number) =>
    factory
      ? `/factory/voucher-detail/${id}`
      : properties
        ? `/properties/voucher-detail/${id}`
        : `/voucher-detail/${id}`;
  const { toast } = useToast();
  const qc = useQueryClient();
  const accounts = useQuery<Account[]>({
    queryKey: ["/api/accounting/cash-bank/accounts"],
    queryFn: () => load("/api/accounting/cash-bank/accounts"),
    retry: false,
  });
  const [account, setAccount] = useState("");
  const [asOfDate, setAsOfDate] = useState("");
  const [domain, setDomain] = useState<Domain | "">("");
  const [partyId, setPartyId] = useState("");
  const [reason, setReason] = useState("");
  const target = useMemo(
    () => accounts.data?.find((a) => account === `${a.accountKind}:${a.accountId}`),
    [account, accounts.data]
  );
  const rates = useQuery<RateMatrix>({
    queryKey: ["/api/accounting/monetary-fx/rates", asOfDate],
    queryFn: () => load(`/api/accounting/monetary-fx/rates${asOfDate ? "?asOfDate=" + asOfDate : ""}`),
    retry: false,
  });
  const valuationUrl = target
    ? `/api/accounting/monetary-fx/cash-bank?accountKind=${target.accountKind}&accountId=${target.accountId}${asOfDate ? "&asOfDate=" + asOfDate : ""}`
    : null;
  const valuation = useQuery<Valuation>({
    queryKey: ["/api/accounting/monetary-fx/cash-bank", valuationUrl],
    queryFn: () => load(valuationUrl!),
    enabled: !!valuationUrl,
    retry: false,
  });
  const pId = partyId ? Number(partyId) : null;
  const query = new URLSearchParams();
  if (domain) query.set("domain", domain);
  if (pId && Number.isSafeInteger(pId) && pId > 0) query.set("partyId", String(pId));
  if (asOfDate) query.set("asOfDate", asOfDate);
  const realized = useQuery<RealizedList>({
    queryKey: ["/api/accounting/monetary-fx/realized", domain, partyId, asOfDate],
    queryFn: () => load(`/api/accounting/monetary-fx/realized?${query.toString()}`),
    retry: false,
  });
  const recognize = useMutation({
    mutationFn: async (matchId: number) => {
      const response = await apiRequest("POST", `/api/accounting/monetary-fx/realized/${matchId}/recognize`, {
        reason,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({
        title: "Realized FX journal posted",
        description: "Matched invoice and settlement originals remain unchanged.",
      });
      setReason("");
      await qc.invalidateQueries({ queryKey: ["/api/accounting/monetary-fx/realized"] });
      await qc.invalidateQueries({ queryKey: ["/api/accounting/monetary-fx/cash-bank"] });
    },
    onError: (err: Error) =>
      toast({ title: "FX recognition refused", description: err.message, variant: "destructive" }),
  });
  return {
    voucher,
    accounts,
    account,
    setAccount,
    asOfDate,
    setAsOfDate,
    domain,
    setDomain,
    partyId,
    setPartyId,
    reason,
    setReason,
    rates,
    valuation,
    realized,
    recognize,
  };
}
