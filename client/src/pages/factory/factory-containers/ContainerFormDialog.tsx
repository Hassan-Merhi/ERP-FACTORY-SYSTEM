import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { enqueueRequest } from "@/lib/offlineQueue";
import { useAdminOverride } from "@/hooks/use-admin-override";
import type { FactorySupplier } from "@shared/schema";
import type { ContainerWithSupplier } from "./otwHelpers";
import { ContainerFormBody } from "./ContainerFormBody";
import type { ApiListRow } from "@shared/apiTypes";

/**
 * Strip unnecessary trailing decimal zeros without scientific notation.
 * "19780.000" → "19780"  "0.3800" → "0.38"  "1.18000000" → "1.18"
 */
function stripTrailingZeros(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value).trim();
  if (!s || s === "null" || s === "undefined") return "";
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** Normalize null / "null" / undefined / "undefined" to empty string. */
function normalizeText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return s === "null" || s === "undefined" ? "" : s;
}

type FormData = {
  containerNumber: string;
  supplierId: string;
  origin: string;
  totalKg: string;
  ratePerKg: string;
  arrivalDate: string;
  notes: string;
  status: string;
  commissionAmount: string;
  commissionCurrencyCode: string;
  commissionAccountId: string;
  commissionSupplierId: string;
  commissionNotes: string;
  freight: string;
  freightCurrencyCode: string;
  freightAccountId: string;
  freightPaidBy: "supplier" | "own";
  freightOwnAccountId: string;
  otherCharges: string;
  otherChargesAccountId: string;
};

type OtherChargeLine = { amount: string; currencyCode: string; ledgerAccountId: string; narration: string };

const BLANK_FORM: FormData = {
  containerNumber: "",
  supplierId: "",
  origin: "",
  totalKg: "",
  ratePerKg: "",
  arrivalDate: "",
  notes: "",
  status: "PENDING",
  commissionAmount: "",
  commissionCurrencyCode: "USD",
  commissionAccountId: "",
  commissionSupplierId: "",
  commissionNotes: "",
  freight: "",
  freightCurrencyCode: "USD",
  freightAccountId: "",
  freightPaidBy: "supplier",
  freightOwnAccountId: "",
  otherCharges: "",
  otherChargesAccountId: "",
};

interface ContainerFormDialogProps {
  open: boolean;
  editingContainer: ContainerWithSupplier | null;
  suppliers: FactorySupplier[] | undefined;
  ledgerAccounts: ApiListRow[];
  onClose: () => void;
}

export function ContainerFormDialog({
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
  const [otherChargeLines, setOtherChargeLines] = useState<OtherChargeLine[]>([]);

  const resetForm = () => {
    setFormData(BLANK_FORM);
    setOtherChargeLines([]);
    setCurrency("USD");
    setFxRate("1");
    setFxRateSource("auto");
    setFxEffectiveDate("");
  };

  useEffect(() => {
    if (!editingContainer) {
      resetForm();
      return;
    }
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
    } & { freightOwnAccountId: Parameters<typeof String>[0] } & { otherCharges: string | number | null | undefined } & {
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
      freightOwnAccountId: c.freightOwnAccountId ? String(c.freightOwnAccountId) : "",
      otherCharges: stripTrailingZeros(c.otherCharges),
      otherChargesAccountId: c.otherChargesAccountId ? String(c.otherChargesAccountId) : "",
    });
    setCurrency(c.currencyCode || "USD");
    setFxRate(stripTrailingZeros(c.fxRateToUsd) || "1");
    setFxRateSource(c.fxRateSource || "auto");
    setFxEffectiveDate(c.fxRateDateImport || "");
  }, [editingContainer]);

  useEffect(() => {
    if (!editingContainer) {
      setOtherChargeLines([]);
      return;
    }
    const containerCcy = (editingContainer as { currencyCode?: string | null }).currencyCode || "USD";
    factoryApiRequest("GET", `/api/factory/containers/${editingContainer.id}/other-charges`)
      .then((res) => (res.ok ? res.json() : []))
      .then((charges: { amount?: string | null; currencyCode?: string | null; ledgerAccountId?: number | null; description?: string | null }[]) => {
        setOtherChargeLines(
          charges.map((c) => ({
            amount: stripTrailingZeros(c.amount),
            currencyCode: c.currencyCode || containerCcy,
            ledgerAccountId: c.ledgerAccountId ? String(c.ledgerAccountId) : "",
            narration: c.description || "",
          }))
        );
      })
      .catch(() => setOtherChargeLines([]));
  }, [editingContainer]);

  useEffect(() => {
    if (currency === "USD") {
      setFxRate("1");
      setFxEffectiveDate("");
      return;
    }
    if (fxRateSource === "manual") return;
    fetch(`/api/factory/fx-rates/latest/${currency}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.rate) {
          setFxRate(String(data.rate));
          setFxEffectiveDate(data.effectiveDate || "");
        }
      })
      .catch(() => {});
  }, [currency, fxRateSource]);

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
          freightAmt > 0 && freightPaidBy === "supplier" && data.supplierId ? parseInt(data.supplierId) : null,
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
          freightAmt > 0 && freightPaidBy === "supplier" && data.supplierId ? parseInt(data.supplierId) : null,
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    const freightAmt = parseFloat(formData.freight || "0");
    if (freightAmt > 0 && formData.freightPaidBy === "own" && !formData.freightOwnAccountId) {
      toast({ title: "Select the account that paid the freight.", variant: "destructive" });
      return;
    }
    if (editingContainer)
      wrapAdminAction(() => updateMutation.mutate({ id: editingContainer.id, data: formData }), "Update Container");
    else createMutation.mutate(formData);
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            resetForm();
            onClose();
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingContainer ? "Edit Container" : "Add Factory Container"}</DialogTitle>
            <DialogDescription>
              {editingContainer ? "Update container details" : "Track a new incoming factory container"}
            </DialogDescription>
          </DialogHeader>

          <ContainerFormBody
            formData={formData}
            setFormData={setFormData}
            currency={currency}
            setCurrency={setCurrency}
            fxRate={fxRate}
            setFxRate={setFxRate}
            fxRateSource={fxRateSource}
            setFxRateSource={setFxRateSource}
            fxEffectiveDate={fxEffectiveDate}
            otherChargeLines={otherChargeLines}
            setOtherChargeLines={setOtherChargeLines}
            activeSuppliers={activeSuppliers}
            filteredSupplierList={filteredSupplierList}
            selectedSupplier={selectedSupplier}
            brokerMismatch={brokerMismatch}
            ledgerAccounts={ledgerAccounts}
          />

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                resetForm();
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={
                !formData.containerNumber || brokerMismatch || createMutation.isPending || updateMutation.isPending
              }
              data-testid="button-save-container"
            >
              {createMutation.isPending || updateMutation.isPending
                ? "Saving..."
                : editingContainer
                  ? "Update"
                  : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </>
  );
}
