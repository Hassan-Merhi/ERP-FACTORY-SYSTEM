/**
 * Form state and container prefill for the production raw-stock OffloadDialog.
 *
 * Extracted from OffloadDialog.tsx during the P1 god-file split. Owns the
 * user-editable fields, the lazy idempotency key, the live USD exchange-rate
 * auto-fetch effects (freight / other charges / commission currencies), the
 * additional-charges row handlers, and the big container-selection prefill
 * (including the PARTIALLY_RECEIVED lock-down path).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { factoryApiRequest } from "@/lib/factoryApi";
import { computeEstimatedAvgCostKg, computePartialReceiptInfo, computeReceiptValue } from "./offloadFormCalculations";
import type {
  AdditionalCharge,
  MixBatchAllocation,
  OffloadContainer,
  OffloadFormFields,
  OffloadSupplierOption,
} from "./offloadDialogTypes";

export function useOffloadFormState(
  open: boolean,
  availableContainers: OffloadContainer[],
  factorySuppliers: OffloadSupplierOption[]
) {
  // Idempotency key is generated lazily on first submit and reused on retries.
  // Reset when the dialog closes or when the user selects a different container.
  const idempotencyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) idempotencyKeyRef.current = null;
  }, [open]);

  const [offloadDate, setOffloadDate] = useState<string>(new Date().toLocaleDateString("en-CA"));
  const [offloadDestination] = useState("");
  const [selectedContainerId, setSelectedContainerId] = useState("");
  const [actualReceivedKg, setActualReceivedKg] = useState("");
  const [costPerKg, setCostPerKg] = useState("");
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [fxRateToUsd, setFxRateToUsd] = useState("1");
  const [freight, setFreight] = useState("");
  const [freightAccountId, setFreightAccountId] = useState("");
  const [freightCurrencyCode, setFreightCurrencyCode] = useState("USD");
  const [freightFxRate, setFreightFxRate] = useState("1");
  const [freightFxRateLoading, setFreightFxRateLoading] = useState(false);
  const [freightFromContainer, setFreightFromContainer] = useState(false);
  const [otherCharges, setOtherCharges] = useState("");
  const [otherChargesAccountId, setOtherChargesAccountId] = useState("");
  const [otherChargesCurrencyCode, setOtherChargesCurrencyCode] = useState("USD");
  const [otherChargesFxRate, setOtherChargesFxRate] = useState("1");
  const [otherChargesFxRateLoading, setOtherChargesFxRateLoading] = useState(false);
  const [otherChargesFromContainer, setOtherChargesFromContainer] = useState(false);
  const [commissionFromContainer, setCommissionFromContainer] = useState(false);
  const [containerCommissionCcy, setContainerCommissionCcy] = useState("USD");
  const [commissionPersonName, setCommissionPersonName] = useState("");
  const [commissionType, setCommissionType] = useState<"PER_KG" | "FIXED">("PER_KG");
  const [commissionRate, setCommissionRate] = useState("");
  const [commissionLedgerAccountId] = useState("");
  const [commissionFxRate, setCommissionFxRate] = useState("1");
  const [commissionFxRateLoading, setCommissionFxRateLoading] = useState(false);
  const [commissionFxEffectiveDate, setCommissionFxEffectiveDate] = useState<string | null>(null);
  const [dutyAmount, setDutyAmount] = useState("");
  const [dutyAccountId, setDutyAccountId] = useState("");
  const [dutyPending, setDutyPending] = useState(false);
  const [dutyNotes] = useState("");
  const [additionalCharges, setAdditionalCharges] = useState<AdditionalCharge[]>([]);
  const [mixBatchAllocations] = useState<MixBatchAllocation[]>([]);

  // ── Additional charge helpers ──────────────────────────────────────────────
  const handleAddAdditionalCharge = () => {
    setAdditionalCharges((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        description: "",
        amount: "",
        currencyCode: "USD",
        fxRate: "1",
        fxRateLoading: false,
        ledgerAccountId: "",
      },
    ]);
  };

  const handleRemoveAdditionalCharge = (id: string) => {
    setAdditionalCharges((prev) => prev.filter((c) => c.id !== id));
  };

  const handleUpdateAdditionalCharge = (id: string, field: string, value: string) => {
    if (field === "currencyCode") {
      if (value === "USD") {
        setAdditionalCharges((prev) =>
          prev.map((c) => (c.id === id ? { ...c, currencyCode: "USD", fxRate: "1", fxRateLoading: false } : c))
        );
      } else {
        setAdditionalCharges((prev) =>
          prev.map((c) => (c.id === id ? { ...c, currencyCode: value, fxRate: "", fxRateLoading: true } : c))
        );
        factoryApiRequest("GET", `/api/factory/fx-rates/latest/${value}`)
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            setAdditionalCharges((prev) =>
              prev.map((c) =>
                c.id === id ? { ...c, fxRate: data?.rate ? String(data.rate) : "", fxRateLoading: false } : c
              )
            );
          })
          .catch(() => {
            setAdditionalCharges((prev) =>
              prev.map((c) => (c.id === id ? { ...c, fxRate: "", fxRateLoading: false } : c))
            );
          });
      }
      return;
    }
    setAdditionalCharges((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  };

  const selectedContainer = useMemo(() => {
    return availableContainers.find((c) => c.id.toString() === selectedContainerId);
  }, [availableContainers, selectedContainerId]);

  /** True when the selected container already has a partial receipt — charges are locked. */
  const isSubsequentReceipt = selectedContainer?.status === "PARTIALLY_RECEIVED";

  /** Breakdown info for PARTIALLY_RECEIVED containers. */
  const partialReceiptInfo = useMemo(() => {
    if (!isSubsequentReceipt || !selectedContainer) return null;
    return computePartialReceiptInfo(selectedContainer);
  }, [isSubsequentReceipt, selectedContainer]);

  /** Live receipt value for subsequent receipts — receivingNow × fixedCostPerKgUsd (USD). */
  const receiptValue = useMemo(() => {
    if (!isSubsequentReceipt || !selectedContainer) return null;
    return computeReceiptValue(selectedContainer, actualReceivedKg);
  }, [isSubsequentReceipt, selectedContainer, actualReceivedKg]);

  const fields: OffloadFormFields = {
    offloadDate,
    offloadDestination,
    selectedContainerId,
    actualReceivedKg,
    costPerKg,
    currencyCode,
    fxRateToUsd,
    freight,
    freightAccountId,
    freightCurrencyCode,
    freightFxRate,
    freightFxRateLoading,
    freightFromContainer,
    otherCharges,
    otherChargesAccountId,
    otherChargesCurrencyCode,
    otherChargesFxRate,
    otherChargesFxRateLoading,
    otherChargesFromContainer,
    commissionFromContainer,
    containerCommissionCcy,
    commissionPersonName,
    commissionType,
    commissionRate,
    commissionLedgerAccountId,
    commissionFxRate,
    commissionFxRateLoading,
    commissionFxEffectiveDate,
    dutyAmount,
    dutyAccountId,
    dutyPending,
    dutyNotes,
    additionalCharges,
    mixBatchAllocations,
  };

  /** Fixed total container value divided by the actual received weight. */
  const estimatedAvgCostKg = useMemo(
    () =>
      computeEstimatedAvgCostKg({
        actualReceivedKg,
        selectedContainerId,
        selectedContainer: selectedContainer ?? null,
        costPerKg,
        fxRateToUsd,
        freight,
        freightFxRate,
        otherCharges,
        otherChargesFxRate,
        commissionPersonName,
        commissionRate,
        commissionFxRate,
        commissionType,
        additionalCharges,
        dutyAmount,
        dutyPending,
      }),
    [
      actualReceivedKg,
      selectedContainer,
      selectedContainerId,
      costPerKg,
      fxRateToUsd,
      freight,
      freightFxRate,
      otherCharges,
      otherChargesFxRate,
      commissionPersonName,
      commissionRate,
      commissionFxRate,
      commissionType,
      additionalCharges,
      dutyAmount,
      dutyPending,
    ]
  );

  // Auto-fetch the live USD exchange rate whenever the freight currency is changed
  // away from USD (and isn't already pinned to the container's own fx rate). Without
  // this, entering e.g. a EUR freight amount with fxRate left at "1" would post it to
  // the ledger as if it were already USD, silently overstating (or understating) the
  // landed cost — mirrors the same auto-fetch on FactoryContainerCreate.tsx.
  useEffect(() => {
    if (freightFromContainer) return;
    if (freightCurrencyCode === "USD") {
      setFreightFxRate("1");
      return;
    }
    setFreightFxRateLoading(true);
    factoryApiRequest("GET", `/api/factory/fx-rates/latest/${freightCurrencyCode}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.rate) setFreightFxRate(String(data.rate));
      })
      .catch(() => {})
      .finally(() => setFreightFxRateLoading(false));
  }, [freightCurrencyCode, freightFromContainer]);

  // Same auto-fetch for Other Charges currency.
  useEffect(() => {
    if (otherChargesFromContainer) return;
    if (otherChargesCurrencyCode === "USD") {
      setOtherChargesFxRate("1");
      return;
    }
    setOtherChargesFxRateLoading(true);
    factoryApiRequest("GET", `/api/factory/fx-rates/latest/${otherChargesCurrencyCode}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.rate) setOtherChargesFxRate(String(data.rate));
      })
      .catch(() => {})
      .finally(() => setOtherChargesFxRateLoading(false));
  }, [otherChargesCurrencyCode, otherChargesFromContainer]);

  // Auto-fetch commission FX when commission currency differs from both USD and the
  // container currency.  A EUR commission on an AUD container must use EUR/USD (1.18),
  // not the container's AUD/USD rate (0.67).
  useEffect(() => {
    const commCcy = containerCommissionCcy.toUpperCase();
    const containerCcy = currencyCode.toUpperCase();
    if (commCcy === "USD") {
      setCommissionFxRate("1");
      setCommissionFxEffectiveDate(null);
      return;
    }
    if (commCcy === containerCcy) {
      // Same currency as container — reuse the already-resolved container FX
      setCommissionFxRate(fxRateToUsd || "1");
      setCommissionFxEffectiveDate(null);
      return;
    }
    // Different non-USD currency — resolve independently
    setCommissionFxRateLoading(true);
    factoryApiRequest("GET", `/api/factory/fx-rates/latest/${commCcy}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.rate) {
          setCommissionFxRate(String(data.rate));
          setCommissionFxEffectiveDate(data.date ?? null);
        }
      })
      .catch(() => {})
      .finally(() => setCommissionFxRateLoading(false));
  }, [containerCommissionCcy, currencyCode, fxRateToUsd]);

  const handleContainerSelect = (id: string) => {
    setSelectedContainerId(id);
    const container = availableContainers.find((c) => c.id.toString() === id);
    if (!container) return;

    const ccy = container.currencyCode || "USD";
    setCurrencyCode(ccy);
    setFxRateToUsd(container.fxRateToUsd || "1");
    setCostPerKg(container.ratePerKg || "");

    // For PARTIALLY_RECEIVED containers the charges were posted at first offload.
    // Default the received-kg field to the remaining amount instead of the full declared weight.
    if (container.status === "PARTIALLY_RECEIVED") {
      const declared = parseFloat(container.totalKg || "0");
      const alreadyReceived = parseFloat(container.actualReceivedKg || "0");
      const remaining = Math.max(0, declared - alreadyReceived);
      setActualReceivedKg(String(remaining.toFixed(3)));
      // For continuation receipts, pre-fill the fixed landed rate from raw stock (informational —
      // the server uses the DB rate; the field is disabled so the user cannot override it).
      setCostPerKg(container.fixedCostPerKgUsd || container.ratePerKg || "");
      // Clear charge fields — they are locked for subsequent receipts
      setFreight("");
      setFreightAccountId("");
      setFreightFromContainer(false);
      setOtherCharges("");
      setOtherChargesAccountId("");
      setOtherChargesFromContainer(false);
      setCommissionPersonName("");
      setCommissionRate("");
      setCommissionFromContainer(false);
      setDutyAmount("");
      setDutyAccountId("");
      setDutyPending(false);
      setAdditionalCharges([]);
      idempotencyKeyRef.current = null; // reset key on new container selection
      return;
    }

    setActualReceivedKg(container.totalKg || "");

    const freightVal = parseFloat(container.freight || "0");
    setFreight(freightVal > 0 ? String(freightVal) : "");
    setFreightFromContainer(freightVal > 0);
    const effectiveFreightCcy = container.freightCurrencyCode || ccy;
    setFreightCurrencyCode(effectiveFreightCcy);
    setFreightFxRate(effectiveFreightCcy === "USD" ? "1" : container.fxRateToUsd || "1");
    // Priority: explicit freight supplier → own account → nothing.
    // DO NOT fall back to container.freightAccountId (that is the DR expense
    // account, not the credit destination) and do not auto-assign the material
    // supplier — the user must explicitly pick where freight goes.
    if (container.freightSupplierId) setFreightAccountId(`SUP:${container.freightSupplierId}`);
    else if (container.freightPaidBy === "own" && container.freightOwnAccountId)
      setFreightAccountId(String(container.freightOwnAccountId));
    else setFreightAccountId("");

    const ocVal = parseFloat(container.otherCharges || "0");
    setOtherCharges(ocVal > 0 ? String(ocVal) : "");
    setOtherChargesFromContainer(ocVal > 0);
    const effectiveOcCcy = container.otherChargesCurrencyCode || ccy;
    setOtherChargesCurrencyCode(effectiveOcCcy);
    setOtherChargesFxRate(effectiveOcCcy === "USD" ? "1" : container.fxRateToUsd || "1");
    if (container.otherChargesSupplierId) setOtherChargesAccountId(`SUP:${container.otherChargesSupplierId}`);
    else if (container.otherChargesAccountId) setOtherChargesAccountId(String(container.otherChargesAccountId));

    const commAmt = parseFloat(container.commissionAmount || "0");
    if (commAmt > 0) {
      setCommissionType("FIXED");
      setCommissionRate(String(commAmt));
      setCommissionFromContainer(true);
      const commCcy = (container.commissionCurrencyCode || ccy).toUpperCase();
      setContainerCommissionCcy(commCcy);
      const broker = container.commissionSupplierId
        ? factorySuppliers.find((s) => s.id === container.commissionSupplierId)
        : null;
      setCommissionPersonName(broker?.name || "Commission");
      // Initialize commission FX: prefer the container's stored commission-specific rate,
      // then fall back to container material FX (valid only when same currency).
      const storedCommFx = parseFloat(container.commissionFxRateToUsd || "");
      const storedCommFxConfirmed = container.commissionFxRateConfirmed === true;
      if (commCcy === "USD") {
        setCommissionFxRate("1");
      } else if (Number.isFinite(storedCommFx) && storedCommFx > 0 && storedCommFxConfirmed) {
        setCommissionFxRate(String(storedCommFx));
      } else if (commCcy === ccy.toUpperCase()) {
        // Same currency as container — container FX applies
        setCommissionFxRate(container.fxRateToUsd || "1");
      } else {
        // Different non-USD currency: will be fetched by the useEffect below
        setCommissionFxRate("");
      }
    }
  };

  return {
    idempotencyKeyRef,
    fields,
    selectedContainer,
    isSubsequentReceipt,
    partialReceiptInfo,
    receiptValue,
    estimatedAvgCostKg,
    // setters used by the dialog UI
    setOffloadDate,
    setActualReceivedKg,
    setCostPerKg,
    setFreight,
    setFreightAccountId,
    setOtherCharges,
    setOtherChargesAccountId,
    setFreightCurrencyCode,
    setOtherChargesCurrencyCode,
    setDutyAmount,
    setDutyAccountId,
    setDutyPending,
    setAdditionalCharges,
    // container + charge row actions
    handleContainerSelect,
    handleAddAdditionalCharge,
    handleRemoveAdditionalCharge,
    handleUpdateAdditionalCharge,
  };
}
