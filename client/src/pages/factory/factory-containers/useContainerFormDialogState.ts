// Extracted from ./ContainerFormDialog.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { enqueueRequest } from "@/lib/offlineQueue";
import { useAdminOverride } from "@/hooks/use-admin-override";
import {
  BLANK_FORM,
  ensureDatedAutoFxRate,
  normalizeText,
  stripTrailingZeros,
  type ContainerFormDialogProps,
  type FormData,
  type OtherChargeLine,
} from "./ContainerFormDialogEnsureDatedAutoFxRate";

export function useContainerFormDialogState({
  open,
  editingContainer,
  suppliers,
  ledgerAccounts,
  onClose,
}: ContainerFormDialogProps) {
  const { toast } = useToast();
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const [formData, setFormData] = useState<FormData>(BLANK_FORM);
  const [currency, setCurrency] = useState("USD");
  const [fxRate, setFxRate] = useState("1");
  const [fxRateSource, setFxRateSource] = useState<"auto" | "manual">("auto");
  const [fxEffectiveDate, setFxEffectiveDate] = useState("");
  const [fxIsSuggestion, setFxIsSuggestion] = useState(false);
  // Hydrating an edit happens after the first render. The FX effect must not
  // apply the previous (usually USD/auto) state over that stored manual rate.
  const skipFxEffectForEditId = useRef<number | null>(null);
  const [otherChargeLines, setOtherChargeLines] = useState<OtherChargeLine[]>([]);

  const resetForm = () => {
    setFormData(BLANK_FORM);
    setOtherChargeLines([]);
    setCurrency("USD");
    setFxRate("1");
    setFxRateSource("auto");
    setFxEffectiveDate("");
    setFxIsSuggestion(false);
  };

  useEffect(() => {
    if (!editingContainer) {
      skipFxEffectForEditId.current = null;
      resetForm();
      return;
    }
    skipFxEffectForEditId.current = editingContainer.id;
    const c = editingContainer as unknown as { containerNumber: string | null | undefined } & {
      supplierId: { toString: (...args: unknown[]) => string };
    } & { origin: string | null | undefined } & { totalKg: string | number | null | undefined } & {
      ratePerKg: string | number | null | undefined;
    } & { arrivalDate: string | null | undefined } & { notes: string | null | undefined } & { status: string } & {
      commissionAmount: string | number | null | undefined;
    } & { commissionCurrencyCode: string } & { commissionAccountId: unknown } & {
      commissionAccountId: Parameters<typeof String>[0];
    } & { commissionSupplierId: unknown } & { commissionSupplierId: Parameters<typeof String>[0] } & {
      commissionNotes: string | null | undefined;
    } & { freight: string | number | null | undefined } & { freightCurrencyCode: string } & {
      freightAccountId: unknown;
    } & { freightAccountId: Parameters<typeof String>[0] } & { freightPaidBy: "supplier" | "own" } & {
      freightOwnAccountId: unknown;
    } & { freightOwnAccountId: Parameters<typeof String>[0] } & {
      freightSupplierId: number | string | null | undefined;
    } & { otherCharges: string | number | null | undefined } & {
      otherChargesAccountId: unknown;
    } & { otherChargesAccountId: Parameters<typeof String>[0] } & { currencyCode: React.SetStateAction<string> } & {
      fxRateToUsd: string | number | null | undefined;
    } & { fxRateSource: React.SetStateAction<"auto" | "manual"> } & { fxRateDateImport: React.SetStateAction<string> };
    setFormData({
      containerNumber: normalizeText(c.containerNumber),
      supplierId: c.supplierId?.toString() || "",
      origin: normalizeText(c.origin),
      totalKg: stripTrailingZeros(c.totalKg),
      ratePerKg: stripTrailingZeros(c.ratePerKg),
      arrivalDate: normalizeText(c.arrivalDate),
      notes: normalizeText(c.notes),
      status: c.status,
      commissionAmount: stripTrailingZeros(c.commissionAmount),
      commissionCurrencyCode: c.commissionCurrencyCode || "USD",
      commissionAccountId: c.commissionAccountId ? String(c.commissionAccountId) : "",
      commissionSupplierId: c.commissionSupplierId ? String(c.commissionSupplierId) : "",
      commissionNotes: normalizeText(c.commissionNotes),
      freight: stripTrailingZeros(c.freight),
      freightCurrencyCode: c.freightCurrencyCode || "USD",
      freightAccountId: c.freightAccountId ? String(c.freightAccountId) : "",
      freightPaidBy: (c.freightPaidBy as "supplier" | "own") || "supplier",
      freightSupplierId: c.freightSupplierId ? String(c.freightSupplierId) : "",
      freightOwnAccountId: c.freightOwnAccountId ? String(c.freightOwnAccountId) : "",
      otherCharges: stripTrailingZeros(c.otherCharges),
      otherChargesAccountId: c.otherChargesAccountId ? String(c.otherChargesAccountId) : "",
    });
    setCurrency(c.currencyCode || "USD");
    setFxRate(stripTrailingZeros(c.fxRateToUsd) || "1");
    setFxRateSource(c.fxRateSource || "auto");
    setFxEffectiveDate(c.fxRateDateImport || "");
    setFxIsSuggestion(false);
  }, [editingContainer]);

  useEffect(() => {
    if (!editingContainer) {
      setOtherChargeLines([]);
      return;
    }
    const containerCcy = (editingContainer as { currencyCode?: string | null }).currencyCode || "USD";
    factoryApiRequest("GET", `/api/factory/containers/${editingContainer.id}/other-charges`)
      .then((res) => (res.ok ? res.json() : []))
      .then(
        (
          charges: {
            amount?: string | null;
            currencyCode?: string | null;
            ledgerAccountId?: number | null;
            description?: string | null;
          }[]
        ) => {
          setOtherChargeLines(
            charges.map((c) => ({
              amount: stripTrailingZeros(c.amount),
              currencyCode: c.currencyCode || containerCcy,
              ledgerAccountId: c.ledgerAccountId ? String(c.ledgerAccountId) : "",
              narration: c.description || "",
            }))
          );
        }
      )
      .catch(() => setOtherChargeLines([]));
  }, [editingContainer]);

  useEffect(() => {
    // On the render where editingContainer changes, currency and fxRateSource
    // still belong to the previous form. The initialization effect above has
    // just loaded the persisted FX fields; do not overwrite them with USD=1
    // (or fetch an unrelated auto quote) using those stale render values.
    if (editingContainer && skipFxEffectForEditId.current === editingContainer.id) {
      skipFxEffectForEditId.current = null;
      return;
    }
    if (currency === "USD") {
      setFxRate("1");
      setFxEffectiveDate("");
      setFxIsSuggestion(false);
      return;
    }
    if (fxRateSource === "manual") return;
    // The "latest" rate is not the historical import rate. When editing an
    // unchanged currency/source, preserve the container's stored rate instead
    // of silently overwriting the form with today's FX quote.
    if (
      editingContainer &&
      currency === (editingContainer.currencyCode || "USD") &&
      fxRateSource === (editingContainer.fxRateSource || "auto") &&
      formData.arrivalDate === (editingContainer.arrivalDate || "")
    ) {
      // Restore the actual stored rate on returning to the original FX mode.
      // Otherwise a quote fetched for another currency could remain in state
      // and later be submitted as a manual historical exchange rate.
      setFxRate(stripTrailingZeros(editingContainer.fxRateToUsd) || "1");
      setFxEffectiveDate(editingContainer.fxRateDateImport || "");
      setFxIsSuggestion(false);
      return;
    }
    // Auto must preview the rate for the container's accounting date, not
    // today's quote when the arrival date is in the past.
    const arrivalDate = formData.arrivalDate.trim();
    const lookupPath = arrivalDate
      ? `/api/factory/fx-rates/${currency}/${arrivalDate}`
      : `/api/factory/fx-rates/latest/${currency}`;
    let cancelled = false;
    factoryApiRequest("GET", lookupPath)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setFxRate(data?.rate ? String(data.rate) : "");
        setFxEffectiveDate(data?.effectiveDate || "");
        setFxIsSuggestion(!!data?.rate && data.saved === false);
      })
      .catch(() => {
        if (cancelled) return;
        setFxRate("");
        setFxEffectiveDate("");
        setFxIsSuggestion(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currency, fxRateSource, editingContainer, formData.arrivalDate]);

  useEffect(() => {
    if (!editingContainer) setFormData((f) => ({ ...f, commissionCurrencyCode: currency }));
  }, [currency, editingContainer]);

  useEffect(() => {
    if (!formData.supplierId) {
      setFormData((f) => ({ ...f, commissionSupplierId: "" }));
      return;
    }
    const sup = suppliers?.find((s) => s.id === parseInt(formData.supplierId));
    if (sup?.parentId) setFormData((f) => ({ ...f, commissionSupplierId: String(sup.parentId) }));
    else if (!formData.commissionSupplierId) setFormData((f) => ({ ...f, commissionSupplierId: "" }));
  }, [formData.commissionSupplierId, formData.supplierId, suppliers]);

  const activeSuppliers = suppliers?.filter((s) => s.isActive) ?? [];
  const brokerIdNum = formData.commissionSupplierId ? parseInt(formData.commissionSupplierId) : null;
  const filteredSupplierList = brokerIdNum
    ? activeSuppliers.filter((s) => s.parentId === brokerIdNum || !s.parentId)
    : activeSuppliers;
  const selectedSupplier = formData.supplierId
    ? (activeSuppliers.find((s) => s.id === parseInt(formData.supplierId)) ?? null)
    : null;
  const brokerMismatch = !!(
    selectedSupplier?.parentId &&
    formData.commissionSupplierId &&
    selectedSupplier.parentId !== parseInt(formData.commissionSupplierId)
  );

  const createMutation = useMutation({
    mutationFn: async (data: FormData) => {
      if (fxRateSource === "auto") await ensureDatedAutoFxRate(currency, data.arrivalDate);
      const freightAmt = parseFloat(data.freight || "0");
      const freightPaidBy = data.freightPaidBy || "supplier";
      const payload = {
        ...data,
        supplierId: data.supplierId ? parseInt(data.supplierId) : null,
        currencyCode: currency,
        fxRateToUsd: fxRateSource === "manual" ? fxRate : undefined,
        fxRateSource,
        commissionAmount: data.commissionAmount || "0",
        commissionCurrencyCode: data.commissionCurrencyCode || currency,
        commissionAccountId: data.commissionAccountId ? parseInt(data.commissionAccountId) : null,
        commissionSupplierId: data.commissionSupplierId ? parseInt(data.commissionSupplierId) : null,
        commissionNotes: data.commissionNotes || null,
        freight: data.freight || "0",
        freightCurrencyCode: data.freightCurrencyCode || "USD",
        freightAccountId: data.freightAccountId ? parseInt(data.freightAccountId) : null,
        // Always send payer fields explicitly — never rely on spread alone
        freightPaidBy,
        freightOwnAccountId:
          freightAmt > 0 && freightPaidBy === "own" && data.freightOwnAccountId
            ? parseInt(data.freightOwnAccountId)
            : null,
        freightSupplierId:
          freightAmt > 0 && freightPaidBy === "supplier" && data.freightSupplierId
            ? parseInt(data.freightSupplierId)
            : null,
        otherCharges: "0",
        otherChargesAccountId: null,
      };
      const res = await factoryApiRequest("POST", "/api/factory/containers", payload);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to create container");
      }
      const container = await res.json();
      await factoryApiRequest("POST", `/api/factory/containers/${container.id}/other-charges/sync`, {
        charges: otherChargeLines
          .filter((l) => parseFloat(l.amount || "0") > 0)
          .map((l) => ({
            description: l.narration?.trim() || "Other Charge",
            amount: l.amount,
            currencyCode: l.currencyCode || currency,
            ledgerAccountId: l.ledgerAccountId ? parseInt(l.ledgerAccountId) : null,
          })),
      });
      return container;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers/with-balances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      toast({
        title: "Container saved",
        description:
          parseFloat(vars.commissionAmount || "0") > 0 ? "Broker commission added." : "Container created successfully.",
      });
      resetForm();
      onClose();
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: FormData }) => {
      const freightAmt = parseFloat(data.freight || "0");
      const freightPaidBy = data.freightPaidBy || "supplier";
      const payload = {
        ...data,
        supplierId: data.supplierId ? parseInt(data.supplierId) : null,
        currencyCode: currency,
        fxRateToUsd: fxRateSource === "manual" ? fxRate : undefined,
        fxRateSource,
        commissionAmount: data.commissionAmount || "0",
        commissionCurrencyCode: data.commissionCurrencyCode || currency,
        commissionAccountId: data.commissionAccountId ? parseInt(data.commissionAccountId) : null,
        commissionSupplierId: data.commissionSupplierId ? parseInt(data.commissionSupplierId) : null,
        commissionNotes: data.commissionNotes || null,
        freight: data.freight || "0",
        freightCurrencyCode: data.freightCurrencyCode || "USD",
        freightAccountId: data.freightAccountId ? parseInt(data.freightAccountId) : null,
        // Always send payer fields explicitly — never rely on spread alone
        freightPaidBy,
        freightOwnAccountId:
          freightAmt > 0 && freightPaidBy === "own" && data.freightOwnAccountId
            ? parseInt(data.freightOwnAccountId)
            : null,
        freightSupplierId:
          freightAmt > 0 && freightPaidBy === "supplier" && data.freightSupplierId
            ? parseInt(data.freightSupplierId)
            : null,
        // Sync all legacy single-row other-charge columns from the first valid
        // charge line so the offload dialog pre-fills amount, account, and currency
        // correctly.  When there are multiple lines the offload dialog still shows
        // one combined amount (sum) — multi-line per-charge posting happens via the
        // per-row system at creation/edit time; offload uses the aggregated values.
        otherCharges: (() => {
          const total = otherChargeLines
            .filter((l) => parseFloat(l.amount || "0") > 0)
            .reduce((sum, l) => sum + parseFloat(l.amount), 0);
          return total > 0 ? String(total) : data.otherCharges || "0";
        })(),
        otherChargesAccountId: (() => {
          const first = otherChargeLines.find((l) => parseFloat(l.amount || "0") > 0);
          if (first?.ledgerAccountId) return parseInt(first.ledgerAccountId);
          return data.otherChargesAccountId ? parseInt(data.otherChargesAccountId) : null;
        })(),
        // Keep the legacy single-row currency column in sync so the offload dialog
        // can read the correct currency when pre-filling the Other Charges field.
        otherChargesCurrencyCode: otherChargeLines.find((l) => parseFloat(l.amount || "0") > 0)?.currencyCode || null,
      };
      // PATCH only the accounting fields the user actually changed. Submitting
      // the entire goods form can make legacy containers with no import journal
      // look like a new payable event even during notes/freight-only edits.
      if (editingContainer?.id === id) {
        const original = editingContainer as unknown as Record<string, unknown>;
        const patch = payload as Record<string, unknown>;
        const normalized = (field: string, value: unknown): string => {
          if (field === "supplierId") return value == null || value === "" ? "" : String(value);
          if (field === "totalKg" || field === "ratePerKg" || field === "fxRateToUsd")
            return stripTrailingZeros(value as string | number | null | undefined) || "0";
          if (field === "currencyCode") return String(value || "USD").toUpperCase();
          return String(value || "auto").toLowerCase();
        };
        const goodsFields = [
          "supplierId",
          "totalKg",
          "ratePerKg",
          "currencyCode",
          "fxRateSource",
          "fxRateToUsd",
        ] as const;
        const changedMode =
          normalized("currencyCode", patch.currencyCode) !== normalized("currencyCode", original.currencyCode) ||
          normalized("fxRateSource", patch.fxRateSource) !== normalized("fxRateSource", original.fxRateSource);
        for (const field of goodsFields) {
          if (patch[field] === undefined) continue;
          // A deliberate switch to manual mode must retain its explicitly
          // chosen rate so the server validates it even if numerically equal.
          if (field === "fxRateToUsd" && changedMode) continue;
          if (normalized(field, patch[field]) === normalized(field, original[field])) delete patch[field];
        }
      }
      // A change to goods/FX can post or reprice a liability. Record any
      // suggested auto rate for the document date before that server write.
      if (
        fxRateSource === "auto" &&
        ["supplierId", "totalKg", "ratePerKg", "currencyCode", "fxRateSource"].some(
          (field) => (payload as Record<string, unknown>)[field] !== undefined
        )
      ) {
        await ensureDatedAutoFxRate(currency, data.arrivalDate);
      }
      const validCharges = otherChargeLines
        .filter((l) => parseFloat(l.amount || "0") > 0)
        .map((l) => ({
          description: l.narration?.trim() || "Other Charge",
          amount: l.amount,
          currencyCode: l.currencyCode || currency,
          ledgerAccountId: l.ledgerAccountId ? parseInt(l.ledgerAccountId) : null,
        }));
      let container: unknown;
      try {
        const res = await factoryApiRequest("PATCH", `/api/factory/containers/${id}`, payload);
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.message || "Failed to update container");
        }
        container = await res.json();
      } catch (err) {
        if (getErrorDetails(err).name === "OfflineQueued" && validCharges.length > 0) {
          enqueueRequest(
            `/api/factory/containers/${id}/other-charges/sync`,
            "POST",
            JSON.stringify({ charges: validCharges }),
            "Container Charges"
          );
        }
        throw err;
      }
      await factoryApiRequest("POST", `/api/factory/containers/${id}/other-charges/sync`, { charges: validCharges });
      return container;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers/with-balances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      toast({
        title: "Container saved",
        description: parseFloat(vars.data.commissionAmount || "0") > 0 ? "Commission linked." : "Container updated.",
      });
      resetForm();
      onClose();
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    if (createMutation.isPending || updateMutation.isPending) return;
    const freightAmt = parseFloat(formData.freight || "0");
    if (freightAmt > 0 && formData.freightPaidBy === "own" && !formData.freightOwnAccountId) {
      toast({ title: "Select the account that paid the freight.", variant: "destructive" });
      return;
    }
    if (editingContainer)
      wrapAdminAction(() => updateMutation.mutate({ id: editingContainer.id, data: formData }), "Update Container");
    else createMutation.mutate(formData);
  };
  return {
    AdminDialog,
    activeSuppliers,
    brokerMismatch,
    createMutation,
    currency,
    editingContainer,
    filteredSupplierList,
    formData,
    fxEffectiveDate,
    fxIsSuggestion,
    fxRate,
    fxRateSource,
    handleSubmit,
    ledgerAccounts,
    onClose,
    open,
    otherChargeLines,
    resetForm,
    selectedSupplier,
    setCurrency,
    setFormData,
    setFxRate,
    setFxRateSource,
    setOtherChargeLines,
    updateMutation,
  };
}
