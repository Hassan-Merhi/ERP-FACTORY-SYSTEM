// Extracted from ./FactoryContainerCreate.tsx to keep that module under the source-size cap.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { FactorySupplier } from "@shared/schema";
import type { ApiListRow } from "@shared/apiTypes";

type OtherChargeLine = { amount: string; currencyCode: string; ledgerAccountId: string };

export function useFactoryContainerCreateState() {
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/containers");
  const { toast } = useToast();
  // Create Only roles may add bale batches and customer-order drafts, not containers.
  const { isCreateOnly } = useExistingRecordChangeAccess();

  const [formData, setFormData] = useState({
    containerNumber: "",
    supplierId: "",
    notes: "",
    commissionAmount: "",
    commissionCurrencyCode: "USD",
    commissionSupplierId: "",
    commissionNotes: "",
    freight: "",
    freightAccountId: "",
    freightCurrencyCode: "USD",
  });

  const [currency, setCurrency] = useState("USD");
  const [totalKg, setTotalKg] = useState("");
  const [ratePerKg, setRatePerKg] = useState("");
  const [otherChargeLines, setOtherChargeLines] = useState<OtherChargeLine[]>([]);
  const [fxRate, setFxRate] = useState("1");
  const [fxRateLoading, setFxRateLoading] = useState(false);
  // Commission-specific FX — kept independent so a EUR commission on an AUD container
  // uses EUR/USD (1.18), not the container's AUD/USD rate (0.67).
  const [commissionFxRate, setCommissionFxRate] = useState("1");
  const [commissionFxRateLoading, setCommissionFxRateLoading] = useState(false);
  const [commissionFxRateDate, setCommissionFxRateDate] = useState<string | null>(null);

  // Auto-fetch the live USD exchange rate whenever a non-USD currency is selected.
  // Without this, fxRateToUsd was previously hardcoded to "1" for every currency,
  // which meant EUR (or any other) amounts were treated as if they were already USD —
  // e.g. a €11,035 container plus a $1,000 USD commission would be added as
  // 11,035 + 1,000 = 12,035 instead of converting the EUR portion to USD first.
  useEffect(() => {
    if (currency === "USD") {
      setFxRate("1");
      return;
    }
    setFxRateLoading(true);
    factoryApiRequest("GET", `/api/factory/fx-rates/latest/${currency}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.rate) setFxRate(String(data.rate));
      })
      .catch(() => {})
      .finally(() => setFxRateLoading(false));
  }, [currency]);

  const updateOtherChargeLine = (idx: number, field: keyof OtherChargeLine, value: string) => {
    setOtherChargeLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  };
  const removeOtherChargeLine = (idx: number) => {
    setOtherChargeLines((prev) => prev.filter((_, i) => i !== idx));
  };

  useEffect(() => {
    setFormData((f) => ({ ...f, commissionCurrencyCode: currency, freightCurrencyCode: currency }));
  }, [currency]);

  // Auto-fetch commission FX whenever the commission currency changes.
  // Must stay independent from the container FX so that, e.g., a EUR commission
  // on an AUD container gets 1 EUR = 1.18 USD, not 1 AUD = 0.67 USD.
  useEffect(() => {
    const commCcy = (formData.commissionCurrencyCode || currency).toUpperCase();
    const containerCcy = currency.toUpperCase();
    if (commCcy === "USD") {
      setCommissionFxRate("1");
      setCommissionFxRateDate(null);
      return;
    }
    if (commCcy === containerCcy) {
      // Same currency as container — reuse the container's already-fetched FX rate
      setCommissionFxRate(fxRate);
      setCommissionFxRateDate(null);
      return;
    }
    // Different non-USD currency: fetch independently
    setCommissionFxRateLoading(true);
    factoryApiRequest("GET", `/api/factory/fx-rates/latest/${commCcy}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.rate) {
          setCommissionFxRate(String(data.rate));
          setCommissionFxRateDate(data.date ?? null);
        } else {
          setCommissionFxRate("");
        }
      })
      .catch(() => setCommissionFxRate(""))
      .finally(() => setCommissionFxRateLoading(false));
  }, [formData.commissionCurrencyCode, currency, fxRate]);

  const { data: suppliers } = useQuery<FactorySupplier[]>({
    queryKey: ["/api/factory/suppliers"],
  });

  const { data: ledgerAccounts = [] } = useQuery<ApiListRow[]>({
    queryKey: ["/api/ledger-accounts?includeHidden=true&profile=picker"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const activeSuppliers = suppliers?.filter((s) => s.isActive) ?? [];

  const selectedSupplier = formData.supplierId
    ? (activeSuppliers.find((s) => s.id === parseInt(formData.supplierId)) ?? null)
    : null;

  // Auto-derive broker from supplier's parentId (true broker balance model)
  const linkedBroker = selectedSupplier?.parentId
    ? (activeSuppliers.find((s) => s.id === selectedSupplier.parentId) ?? null)
    : null;

  // When supplier changes: if it has a linked broker, auto-set commissionSupplierId
  useEffect(() => {
    if (selectedSupplier?.parentId) {
      setFormData((f) => ({ ...f, commissionSupplierId: String(selectedSupplier.parentId) }));
    }
    // If supplier has no parent, clear any previously auto-set broker only if it was auto-derived
    // (we leave manually-chosen broker intact when supplier has no parent)
  }, [selectedSupplier?.id, selectedSupplier?.parentId]);

  // Show all active suppliers in the dropdown
  const filteredSupplierList = activeSuppliers;

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        containerNumber: formData.containerNumber,
        supplierId: formData.supplierId ? parseInt(formData.supplierId) : null,
        notes: formData.notes || null,
        status: "PENDING",
        currencyCode: currency,
        fxRateToUsd: currency === "USD" ? "1" : fxRate,
        fxRateSource: "auto",
        totalKg: totalKg || null,
        ratePerKg: ratePerKg || null,
        commissionAmount: formData.commissionAmount || "0",
        commissionCurrencyCode: formData.commissionCurrencyCode || currency,
        commissionSupplierId: formData.commissionSupplierId ? parseInt(formData.commissionSupplierId) : null,
        commissionNotes: formData.commissionNotes || null,
        freight: formData.freight || "0",
        freightCurrencyCode: formData.freightCurrencyCode || currency,
        freightAccountId: formData.freightAccountId ? parseInt(formData.freightAccountId) : null,
        otherCharges: "0",
        otherChargesAccountId: null,
      };
      const res = await factoryApiRequest("POST", "/api/factory/containers", payload);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to create container");
      }
      const container = await res.json();
      const validLines = otherChargeLines.filter((l) => parseFloat(l.amount || "0") > 0);
      if (validLines.length > 0) {
        await factoryApiRequest("POST", `/api/factory/containers/${container.id}/other-charges/sync`, {
          charges: validLines.map((l) => ({
            description: "Other Charge",
            amount: l.amount,
            currencyCode: l.currencyCode || currency,
            ledgerAccountId: l.ledgerAccountId ? parseInt(l.ledgerAccountId) : null,
          })),
        });
      }
      return container;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      const hasCommission = parseFloat(formData.commissionAmount || "0") > 0;
      toast({
        title: "Container created",
        description: hasCommission
          ? "Container created and commission account set up automatically."
          : "Container created successfully.",
      });
      navigate("/factory/containers");
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const commissionCcy = (formData.commissionCurrencyCode || currency).toUpperCase();
  const commissionAmt2 = parseFloat(formData.commissionAmount || "0");
  const commissionFxUnresolved =
    commissionAmt2 > 0 &&
    commissionCcy !== "USD" &&
    commissionCcy !== currency.toUpperCase() &&
    (commissionFxRateLoading || !(parseFloat(commissionFxRate) > 0));

  const canSubmit =
    !!formData.containerNumber &&
    !createMutation.isPending &&
    !(currency !== "USD" && (fxRateLoading || !(parseFloat(fxRate) > 0))) &&
    !commissionFxUnresolved;
  return {
    canSubmit,
    commissionAmt2,
    commissionCcy,
    commissionFxRate,
    commissionFxRateDate,
    commissionFxRateLoading,
    createMutation,
    currency,
    filteredSupplierList,
    formData,
    fxRate,
    fxRateLoading,
    isCreateOnly,
    ledgerAccounts,
    linkedBroker,
    navigate,
    otherChargeLines,
    ratePerKg,
    removeOtherChargeLine,
    setCurrency,
    setFormData,
    setOtherChargeLines,
    setRatePerKg,
    setTotalKg,
    totalKg,
    updateOtherChargeLine,
  };
}
