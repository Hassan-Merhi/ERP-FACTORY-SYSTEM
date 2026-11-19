// Extracted from ./useFactoryBrokerVisualStatementState.tsx
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { factoryApiRequest } from "@/lib/factoryApi";

interface BrokerSupplier {
  id: number;
  name: string;
  parentId?: number | null;
}

export interface BrokerContainer {
  id: number;
  supplierName: string;
  containerNumber: string;
  arrivalDate?: string | null;
  ratePerKg: number;
  weight: number;
  goodsAmount: number;
  goodsCurrency: string;
  freightAmount: number;
  freightCurrency: string;
  commissionAmount: number;
  commissionCurrency: string;
}

export interface BrokerPayment {
  id: number;
  date?: string | null;
  type: string;
  supplierName?: string | null;
  fromCurrency: string;
  fromAmount: number;
  fxRate?: number | null;
  usdAmount: number;
  notes?: string | null;
}

interface BrokerStatement {
  broker?: { name: string } | null;
  containers: BrokerContainer[];
  payments: BrokerPayment[];
}

export function useFactoryBrokerVisualStatementStatePart1() {
  const { formatDisplayDate } = useDateFormat();

  const [brokerId, setBrokerId] = useState<string>("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  // Suppliers for the current factory company (server reads company from session)
  const { data: suppliers = [] } = useQuery<BrokerSupplier[]>({
    queryKey: ["/api/factory/suppliers"],
  });

  // Brokers = suppliers that have children OR have parentId = null and are linked
  const parentIds = useMemo(() => {
    const ids = new Set<number>();
    for (const s of suppliers) {
      if (s.parentId) ids.add(s.parentId);
    }
    return ids;
  }, [suppliers]);
  const brokers = useMemo(() => suppliers.filter((s) => parentIds.has(s.id)), [suppliers, parentIds]);

  // Visual statement data
  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p.toString();
  }, [from, to]);

  const {
    data: statement,
    isLoading,
    error,
  } = useQuery<BrokerStatement>({
    queryKey: ["/api/factory/suppliers", brokerId, "broker-visual-statement", from, to],
    queryFn: async () => {
      const qs = queryParams ? `?${queryParams}` : "";
      const res = await factoryApiRequest("GET", `/api/factory/suppliers/${brokerId}/broker-visual-statement${qs}`);
      if (!res.ok) throw new Error("Failed to load statement");
      return res.json();
    },
    enabled: !!brokerId,
  });

  // ── Derived totals ──────────────────────────────────────────────────────────

  const containerTotals = useMemo(() => {
    if (!statement?.containers) return {} as Record<string, { goods: number; freight: number; commission: number }>;
    const totals: Record<string, { goods: number; freight: number; commission: number }> = {};
    const add = (cc: string, field: "goods" | "freight" | "commission", amt: number) => {
      if (!totals[cc]) totals[cc] = { goods: 0, freight: 0, commission: 0 };
      totals[cc][field] += amt;
    };
    for (const c of statement.containers) {
      if (c.goodsAmount) add(c.goodsCurrency, "goods", c.goodsAmount);
      if (c.freightAmount) add(c.freightCurrency, "freight", c.freightAmount);
      if (c.commissionAmount) add(c.commissionCurrency, "commission", c.commissionAmount);
    }
    return totals;
  }, [statement]);

  const paymentTotals = useMemo(() => {
    if (!statement?.payments) return {} as Record<string, number>;
    const totals: Record<string, number> = {};
    for (const p of statement.payments) {
      totals[p.fromCurrency] = (totals[p.fromCurrency] || 0) + p.fromAmount;
    }
    return totals;
  }, [statement]);

  // All currencies present across containers + payments
  const allCurrencies = useMemo(() => {
    const set = new Set<string>();
    for (const cc of Object.keys(containerTotals)) set.add(cc);
    for (const cc of Object.keys(paymentTotals)) set.add(cc);
    // Preferred order
    const order = ["EUR", "AUD", "USD"];
    return [...order.filter((c) => set.has(c)), ...[...set].filter((c) => !order.includes(c))];
  }, [containerTotals, paymentTotals]);
  return {
    formatDisplayDate,
    brokerId,
    setBrokerId,
    from,
    setFrom,
    setTo,
    to,
    brokers,
    error,
    isLoading,
    statement,
    containerTotals,
    paymentTotals,
    allCurrencies,
  };
}
