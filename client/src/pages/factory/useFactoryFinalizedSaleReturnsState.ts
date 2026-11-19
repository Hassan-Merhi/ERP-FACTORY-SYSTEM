// Extracted from ./FactoryFinalizedSaleReturns.tsx
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { getFinalizedSaleReturnCopy, finalizedSaleReturnCopy } from "@/i18n/factoryFinalizedSaleReturnTranslations";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type Invoice = {
  id: number;
  invoiceNumber: string;
  containerNumber: string | null;
  customerName: string | null;
  grandTotal: string;
  quantity: number;
};

type Bale = {
  baleId: number;
  referenceNumber: string;
  articleCode: string | null;
  productName: string | null;
  priceUsed: string;
  weightKg: string;
  status: string;
};

type Detail = {
  order: {
    id: number;
    invoiceNumber: string;
    containerNumber: string | null;
    grandTotal: string;
    totalQtyBales: number;
  };
  bales: Bale[];
  blockedReason: string | null;
};

type ReturnHistory = {
  returnBatch: string;
  invoiceNumber: string;
  containerNumber: string | null;
  articleCode: string | null;
  productName: string | null;
  quantity: number;
  baleReferences: string;
  returnedAt: string;
  returnedBy: string;
  reason: string;
};

type ApplyResult = {
  invoiceNumber: string;
  quantity: number;
  customerCredit: string;
  snapshotUpdated: boolean;
  warning: string | null;
};

const api = "/api/factory/finalized-sale-returns";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || finalizedSaleReturnCopy.en.requestFailed);
  return value as T;
}

export function useFactoryFinalizedSaleReturnsState() {
  const { selectedCompany } = useCompany();
  const { language } = useApplicationLanguage();
  const copy = getFinalizedSaleReturnCopy(language);
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [orderId, setOrderId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);

  useEffect(() => {
    setOrderId(null);
    setSelected([]);
    setSearch("");
    setReason("");
    setConfirmed(false);
    setResult(null);
  }, [selectedCompany?.id]);

  const { data: invoices = [] } = useQuery<Invoice[]>({
    queryKey: companyQueryKey(api + "/orders", selectedCompany?.id, search),
    queryFn: () => fetchJson(api + "/orders?search=" + encodeURIComponent(search)),
    enabled: !!selectedCompany?.id,
  });
  const { data: detail } = useQuery<Detail>({
    queryKey: companyQueryKey(api + "/orders/" + orderId, selectedCompany?.id),
    queryFn: () => fetchJson(api + "/orders/" + orderId),
    enabled: !!selectedCompany?.id && orderId !== null,
  });
  const { data: history = [] } = useQuery<ReturnHistory[]>({
    queryKey: companyQueryKey(api + "/history", selectedCompany?.id),
    queryFn: () => fetchJson(api + "/history"),
    enabled: !!selectedCompany?.id,
  });

  const groups = useMemo(() => {
    const byArticle = new Map<string, { name: string; code: string; bales: Bale[] }>();
    for (const bale of detail?.bales ?? []) {
      const code = bale.articleCode || copy.noArticle;
      const name = bale.productName || code;
      const key = code + ":" + name;
      const group = byArticle.get(key) || { code, name, bales: [] };
      group.bales.push(bale);
      byArticle.set(key, group);
    }
    return [...byArticle.values()];
  }, [detail?.bales, copy.noArticle]);
  const chosen = detail?.bales.filter((b) => selected.includes(b.baleId)) ?? [];
  const priced = chosen.reduce((value, bale) => value + Number(bale.priceUsed || 0), 0);

  const mutation = useMutation({
    mutationFn: () =>
      fetchJson<ApplyResult>(api + "/apply", {
        method: "POST",
        body: JSON.stringify({
          orderId,
          baleIds: selected,
          reason,
          confirmReturn: confirmed,
          expectedTotal: detail?.order.grandTotal,
        }),
      }),
    onSuccess: (response) => {
      setResult(response);
      setSelected([]);
      setReason("");
      setConfirmed(false);
      queryClient.invalidateQueries({ queryKey: [api + "/orders"] });
      queryClient.invalidateQueries({ queryKey: [api + "/history"] });
      queryClient.invalidateQueries({ queryKey: [api + "/orders/" + orderId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      toast({ title: copy.postedToast, description: response.quantity + " " + copy.postedToastDetail });
    },
    onError: (e: Error) => toast({ title: copy.blockedToast, description: e.message, variant: "destructive" }),
  });
  const toggleBale = (id: number, checked: boolean) =>
    setSelected((old) => (checked ? [...new Set([...old, id])] : old.filter((x) => x !== id)));
  return {
    copy,
    search,
    setSearch,
    setOrderId,
    orderId,
    setSelected,
    selected,
    reason,
    setReason,
    setConfirmed,
    confirmed,
    setResult,
    result,
    invoices,
    detail,
    history,
    groups,
    chosen,
    priced,
    mutation,
    toggleBale,
  };
}
