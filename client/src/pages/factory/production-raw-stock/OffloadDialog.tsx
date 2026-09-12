import { useState, useMemo, useEffect, useRef } from "react";
import { factoryApiRequest } from "@/lib/factoryApi";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Plus, X, Info, Lock, ChevronsUpDown, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatNumber } from "@/lib/formatNumber";
import { resolveFactoryOffloadValuationKg } from "@shared/factoryOffloadValuation";
import { AccountCombobox } from "./ProductionRawStockHelpers";
import type { AdditionalCharge, MixBatchAllocation, OffloadDialogProps, OffloadPayload } from "./offloadDialogTypes";

export function OffloadDialog({
  open,
  onOpenChange,
  availableContainers,
  factorySuppliers,
  ledgerAccounts,
  offloadMutation,
  wrapAdminAction,
  mixBatches: _mixBatches,
}: OffloadDialogProps) {
  const { toast: _toast } = useToast();
  // Idempotency key is generated lazily on first submit and reused on retries.
  // Reset when the dialog closes or when the user selects a different container.
  const idempotencyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) idempotencyKeyRef.current = null;
  }, [open]);
  const [offloadDate, setOffloadDate] = useState<string>(new Date().toLocaleDateString("en-CA"));
  const [offloadDestination, _setOffloadDestination] = useState("");
  const [selectedContainerId, setSelectedContainerId] = useState("");
  const [containerComboOpen, setContainerComboOpen] = useState(false);
  const [actualReceivedKg, setActualReceivedKg] = useState("");
  const [costPerKg, setCostPerKg] = useState("");
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [fxRateToUsd, setFxRateToUsd] = useState("1");
  const [freight, setFreight] = useState("");
  const [freightAccountId, setFreightAccountId] = useState("");
  const [freightCurrencyCode, setFreightCurrencyCode] = useState("USD");
  const [freightFxRate, setFreightFxRate] = useState("1");
  const [freightFromContainer, setFreightFromContainer] = useState(false);
  const [freightFxRateLoading, setFreightFxRateLoading] = useState(false);
  const [otherCharges, setOtherCharges] = useState("");
  const [otherChargesAccountId, setOtherChargesAccountId] = useState("");
  const [otherChargesCurrencyCode, setOtherChargesCurrencyCode] = useState("USD");
  const [otherChargesFxRate, setOtherChargesFxRate] = useState("1");
  const [otherChargesFromContainer, setOtherChargesFromContainer] = useState(false);
  const [otherChargesFxRateLoading, setOtherChargesFxRateLoading] = useState(false);
  const [commissionFromContainer, setCommissionFromContainer] = useState(false);
  const [containerCommissionCcy, setContainerCommissionCcy] = useState("USD");
  const [commissionPersonName, setCommissionPersonName] = useState("");
  const [commissionType, setCommissionType] = useState<"PER_KG" | "FIXED">("PER_KG");
  const [commissionRate, setCommissionRate] = useState("");
  const [commissionLedgerAccountId, _setCommissionLedgerAccountId] = useState("");
  // Commission-specific FX rate — kept independent from the container's material FX so a
  // EUR commission on an AUD container uses EUR/USD (1.18), not AUD/USD (0.67).
  const [commissionFxRate, setCommissionFxRate] = useState("1");
  const [commissionFxRateLoading, setCommissionFxRateLoading] = useState(false);
  const [commissionFxEffectiveDate, setCommissionFxEffectiveDate] = useState<string | null>(null);
  const [dutyAmount, setDutyAmount] = useState("");
  const [dutyAccountId, setDutyAccountId] = useState("");
  const [dutyPending, setDutyPending] = useState(false);
  const [dutyNotes, _setDutyNotes] = useState("");
  const [additionalCharges, setAdditionalCharges] = useState<AdditionalCharge[]>([]);
  const [mixBatchAllocations, _setMixBatchAllocations] = useState<MixBatchAllocation[]>([]);

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
    return availableContainers?.find((c) => c.id.toString() === selectedContainerId);
  }, [availableContainers, selectedContainerId]);

  /** True when the selected container already has a partial receipt — charges are locked. */
  const isSubsequentReceipt = selectedContainer?.status === "PARTIALLY_RECEIVED";

  /** Breakdown info for PARTIALLY_RECEIVED containers. */
  const partialReceiptInfo = useMemo(() => {
    if (!isSubsequentReceipt || !selectedContainer) return null;
    const declared = parseFloat(selectedContainer.totalKg || "0");
    const alreadyReceived = parseFloat(selectedContainer.actualReceivedKg || "0");
    const remaining = Math.max(0, declared - alreadyReceived);
    return { declared, alreadyReceived, remaining };
  }, [isSubsequentReceipt, selectedContainer]);

  /** Live receipt value for subsequent receipts — receivingNow × fixedCostPerKgUsd (USD). */
  const receiptValue = useMemo(() => {
    if (!isSubsequentReceipt || !selectedContainer) return null;
    const kg = parseFloat(actualReceivedKg || "0");
    const rate = parseFloat(selectedContainer.fixedCostPerKgUsd || "0");
    if (!kg || !rate) return null;
    return kg * rate;
  }, [isSubsequentReceipt, selectedContainer, actualReceivedKg]);

  /** Fixed total container value divided by the actual received weight. */
  const estimatedAvgCostKg = useMemo(() => {
    const receivedKg = parseFloat(actualReceivedKg || "0");
    if (!receivedKg || !selectedContainerId || !selectedContainer) return null;

    const valuationKg = resolveFactoryOffloadValuationKg({
      totalKg: selectedContainer.totalKg,
      declaredKg: selectedContainer.declaredKg,
      receivedKg,
    });
    if (valuationKg <= 0) return null;

    const materialUsd = parseFloat(costPerKg || "0") * parseFloat(fxRateToUsd || "1") * valuationKg;
    const freightUsd = parseFloat(freight || "0") * parseFloat(freightFxRate || "1");
    const otherUsd = parseFloat(otherCharges || "0") * parseFloat(otherChargesFxRate || "1");

    let commissionUsd = 0;
    if (commissionPersonName.trim() && parseFloat(commissionRate || "0") > 0) {
      const commBase = parseFloat(commissionRate || "0") * parseFloat(commissionFxRate || "1");
      commissionUsd = commissionType === "PER_KG" ? commBase * valuationKg : commBase;
    }

    const extraUsd = additionalCharges
      .filter((c) => parseFloat(c.amount || "0") > 0)
      .reduce((sum, c) => sum + parseFloat(c.amount || "0") * parseFloat(c.fxRate || "1"), 0);

    const dutyUsd = dutyPending ? 0 : parseFloat(dutyAmount || "0");
    const totalUsd = materialUsd + freightUsd + otherUsd + commissionUsd + extraUsd + dutyUsd;

    return totalUsd / receivedKg;
  }, [
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
  ]);

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
    const container = availableContainers?.find((c) => c.id.toString() === id);
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
        ? factorySuppliers?.find((s) => s.id === container.commissionSupplierId)
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

  const parseAccountValue = (val: string) => {
    if (!val) return null;
    if (val.startsWith("SUP:")) return { type: "supplier", id: parseInt(val.split(":")[1]) };
    return { type: "ledger", id: parseInt(val) };
  };

  const handleSubmit = () => {
    if (!selectedContainerId) return;
    const dutyStatus = dutyPending ? "PENDING" : parseFloat(dutyAmount || "0") > 0 ? "CONFIRMED" : "NONE";
    const fxRate = parseFloat(fxRateToUsd || "1");

    const payload: OffloadPayload = {
      containerId: selectedContainerId,
      offloadDate,
      destination: offloadDestination.trim() || null,
      receivedKg: actualReceivedKg,
      costPerKg,
      currencyCode,
      fxRateToUsd,
      freight: freight || "0",
      freightCurrencyCode,
      freightFxRate,
      ...(() => {
        const p = parseAccountValue(freightAccountId);
        return p?.type === "supplier" ? { freightSupplierId: p.id } : { freightAccountId: p?.id ?? null };
      })(),
      ...(() => {
        const p = parseAccountValue(otherChargesAccountId);
        return p?.type === "supplier"
          ? {
              otherChargesSupplierId: p.id,
              otherCharges: otherCharges || "0",
              otherChargesCurrencyCode,
              otherChargesFxRate,
            }
          : {
              otherChargesAccountId: p?.id ?? null,
              otherCharges: otherCharges || "0",
              otherChargesCurrencyCode,
              otherChargesFxRate,
            };
      })(),
      dutyAmount: (() => {
        const rawAmt = parseFloat(dutyAmount || "0");
        if (rawAmt === 0) return "0";
        if (currencyCode === "USD") return dutyAmount || "0";
        return String(rawAmt / (fxRate || 1));
      })(),
      dutyAccountId: dutyAccountId ? parseInt(dutyAccountId) : null,
      dutyStatus,
      dutyNotes: dutyNotes || null,
      additionalCharges: additionalCharges
        .filter((c) => parseFloat(c.amount || "0") > 0)
        .map((c) => {
          const p = parseAccountValue(c.ledgerAccountId);
          return {
            description: c.description || "Additional Charge",
            amount: c.amount,
            currencyCode: c.currencyCode || "USD",
            fxRateToUsd: c.fxRate || (c.currencyCode === "USD" ? "1" : undefined),
            ledgerAccountId: p?.type === "ledger" ? p.id : null,
            supplierId: p?.type === "supplier" ? p.id : null,
          };
        }),
      mixBatchAllocations: mixBatchAllocations
        .filter((a) => a.mixBatchId && parseFloat(a.weightKg || "0") > 0)
        .map((a) => ({
          mixBatchId: parseInt(a.mixBatchId || "0", 10),
          weightKg: a.weightKg,
        })),
    };

    if (commissionPersonName.trim() && parseFloat(commissionRate || "0") > 0) {
      const commCcy = (commissionFromContainer ? containerCommissionCcy : "USD").toUpperCase();
      payload.commission = {
        personName: commissionPersonName.trim(),
        commissionType,
        commissionRate,
        currencyCode: commCcy,
        // Always send the commission-specific FX rate, not the container's material FX.
        // The server validates/resolves this independently and is the authoritative source.
        fxRateToUsd: commCcy === "USD" ? "1" : commissionFxRate,
        fxRateDate: commissionFxEffectiveDate,
        ledgerAccountId: commissionLedgerAccountId || null,
      };
    }

    // Generate idempotency key lazily on first submit; reuse on retries until dialog closes.
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    payload.idempotencyKey = idempotencyKeyRef.current;

    offloadMutation.mutate(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-emerald-600" />
            Offload Container
          </DialogTitle>
          <DialogDescription>
            Register received weight and link container costs to production raw stock.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Select Container</Label>
              <Popover open={containerComboOpen} onOpenChange={setContainerComboOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={containerComboOpen}
                    className="w-full justify-between font-normal"
                  >
                    <span className="truncate">
                      {selectedContainerId
                        ? (() => {
                            const c = availableContainers?.find((x) => x.id.toString() === selectedContainerId);
                            return c
                              ? `${c.containerNumber} (${c.totalKg} kg — ${c.supplierName})${c.status === "PARTIALLY_RECEIVED" ? " [Partial]" : ""}`
                              : "Select container...";
                          })()
                        : "Select container..."}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="p-0" style={{ width: "var(--radix-popover-trigger-width)" }} align="start">
                  <Command>
                    <CommandInput placeholder="Search container number or supplier..." />
                    <CommandList>
                      <CommandEmpty>No container found.</CommandEmpty>
                      <CommandGroup>
                        {availableContainers?.map((c) => (
                          <CommandItem
                            key={c.id}
                            value={`${c.containerNumber} ${c.supplierName}`}
                            onSelect={() => {
                              handleContainerSelect(c.id.toString());
                              setContainerComboOpen(false);
                            }}
                          >
                            <Check
                              className={`mr-2 h-4 w-4 shrink-0 ${selectedContainerId === c.id.toString() ? "opacity-100" : "opacity-0"}`}
                            />
                            <span className="truncate">
                              {c.containerNumber} ({c.totalKg} kg — {c.supplierName})
                              {c.status === "PARTIALLY_RECEIVED" ? " [Partial]" : ""}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2">
              <Label>Offload Date</Label>
              <Input type="date" value={offloadDate} onChange={(e) => setOffloadDate(e.target.value)} />
            </div>
          </div>

          {/* Subsequent receipt info banner */}
          {isSubsequentReceipt && partialReceiptInfo && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-2">
              <div className="flex items-center gap-2 text-blue-700 font-semibold text-sm">
                <Info className="h-4 w-4" />
                Subsequent Receipt — Partial Container
              </div>
              <div className="grid grid-cols-3 gap-2 text-sm text-blue-800">
                <span>
                  Declared: <strong>{formatNumber(partialReceiptInfo.declared)} kg</strong>
                </span>
                <span>
                  Already received: <strong>{formatNumber(partialReceiptInfo.alreadyReceived)} kg</strong>
                </span>
                <span>
                  Remaining: <strong>{formatNumber(partialReceiptInfo.remaining)} kg</strong>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm text-blue-800">
                <span>
                  Fixed Landed Cost/KG (USD):{" "}
                  <strong>
                    {selectedContainer?.fixedCostPerKgUsd
                      ? formatNumber(parseFloat(selectedContainer.fixedCostPerKgUsd), 6)
                      : "—"}{" "}
                    USD/kg
                  </strong>
                </span>
                <span>
                  Value of This Receipt:{" "}
                  <strong>{receiptValue != null ? `${formatNumber(receiptValue, 2)} USD` : "—"}</strong>
                </span>
              </div>
              <p className="text-xs text-blue-600 flex items-center gap-1">
                <Lock className="h-3 w-3" />
                Freight, charges, and commission are locked — they were posted on the first receipt. Only the received
                weight applies here.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>
                Received Weight (KG)
                {isSubsequentReceipt && partialReceiptInfo
                  ? ` (max ${formatNumber(partialReceiptInfo.remaining)} kg remaining)`
                  : ""}
              </Label>
              <Input
                type="number"
                step="0.001"
                value={actualReceivedKg}
                onChange={(e) => setActualReceivedKg(e.target.value)}
                placeholder="0.000"
              />
            </div>
            <div className="space-y-2">
              <Label>Base Cost per KG ({currencyCode})</Label>
              <Input
                type="number"
                step="0.0001"
                value={costPerKg}
                onChange={(e) => setCostPerKg(e.target.value)}
                placeholder="0.0000"
                disabled={isSubsequentReceipt}
              />
              {isSubsequentReceipt && (
                <p className="text-xs text-muted-foreground">Rate established at first offload — not editable here.</p>
              )}
            </div>
          </div>

          {isSubsequentReceipt ? (
            <div className="rounded-lg border border-muted bg-muted/30 p-4 text-sm text-muted-foreground flex items-center gap-2">
              <Lock className="h-4 w-4 shrink-0" />
              Freight, other charges, commission, duty, and additional charges were recorded on the first receipt and
              are not re-posted here. The fixed landed cost/kg ({selectedContainer?.currencyCode}) already covers the
              full container.
            </div>
          ) : (
            <>
              <Separator />
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-4">
                  <h3 className="font-semibold text-sm">Freight & Other Charges</h3>
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <div className="space-y-2">
                      <Label>Freight Cost</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={freight}
                        onChange={(e) => setFreight(e.target.value)}
                        disabled={freightFromContainer}
                        placeholder="0.00"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Currency</Label>
                      <Select
                        value={freightCurrencyCode}
                        onValueChange={setFreightCurrencyCode}
                        disabled={freightFromContainer}
                      >
                        <SelectTrigger className="w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="USD">USD</SelectItem>
                          <SelectItem value="EUR">EUR</SelectItem>
                          <SelectItem value="AUD">AUD</SelectItem>
                          <SelectItem value="GBP">GBP</SelectItem>
                          <SelectItem value="LBP">LBP</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {freightCurrencyCode !== "USD" && (
                    <p className="text-xs text-muted-foreground -mt-2">
                      {freightFxRateLoading
                        ? "Fetching current exchange rate…"
                        : parseFloat(freightFxRate) > 0
                          ? `1 ${freightCurrencyCode} = ${formatNumber(parseFloat(freightFxRate))} USD — freight will be posted to the ledger in USD.`
                          : "Exchange rate unavailable — enter it manually to convert this charge to USD."}
                    </p>
                  )}
                  <div className="space-y-2">
                    <Label>Freight Account</Label>
                    <AccountCombobox
                      value={freightAccountId}
                      onValueChange={setFreightAccountId}
                      accounts={ledgerAccounts}
                      suppliers={factorySuppliers}
                    />
                  </div>

                  <Separator />

                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <div className="space-y-2">
                      <Label>Other Charges</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={otherCharges}
                        onChange={(e) => setOtherCharges(e.target.value)}
                        disabled={otherChargesFromContainer}
                        placeholder="0.00"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Currency</Label>
                      <Select
                        value={otherChargesCurrencyCode}
                        onValueChange={setOtherChargesCurrencyCode}
                        disabled={otherChargesFromContainer}
                      >
                        <SelectTrigger className="w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="USD">USD</SelectItem>
                          <SelectItem value="EUR">EUR</SelectItem>
                          <SelectItem value="AUD">AUD</SelectItem>
                          <SelectItem value="GBP">GBP</SelectItem>
                          <SelectItem value="LBP">LBP</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {otherChargesCurrencyCode !== "USD" && (
                    <p className="text-xs text-muted-foreground -mt-2">
                      {otherChargesFxRateLoading
                        ? "Fetching current exchange rate…"
                        : parseFloat(otherChargesFxRate) > 0
                          ? `1 ${otherChargesCurrencyCode} = ${formatNumber(parseFloat(otherChargesFxRate))} USD — other charges will be posted to the ledger in USD.`
                          : "Exchange rate unavailable — enter it manually to convert this charge to USD."}
                    </p>
                  )}
                  <div className="space-y-2">
                    <Label>Other Charges Account</Label>
                    <AccountCombobox
                      value={otherChargesAccountId}
                      onValueChange={setOtherChargesAccountId}
                      accounts={ledgerAccounts}
                      suppliers={factorySuppliers}
                      disabled={otherChargesFromContainer}
                    />
                  </div>

                  <Separator />

                  {/* ── Extra Charges (multiple rows) ── */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm text-muted-foreground">Extra Charges</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 text-xs"
                        onClick={handleAddAdditionalCharge}
                      >
                        <Plus className="h-3 w-3" />
                        Add
                      </Button>
                    </div>
                    {additionalCharges.length > 0 && (
                      <div className="space-y-3">
                        {additionalCharges.map((charge) => (
                          <div key={charge.id} className="rounded-md border p-3 space-y-2 bg-muted/20">
                            <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
                              <Input
                                placeholder="Description"
                                value={charge.description}
                                onChange={(e) => handleUpdateAdditionalCharge(charge.id, "description", e.target.value)}
                              />
                              <Select
                                value={charge.currencyCode}
                                onValueChange={(v) => handleUpdateAdditionalCharge(charge.id, "currencyCode", v)}
                              >
                                <SelectTrigger className="w-24">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="USD">USD</SelectItem>
                                  <SelectItem value="EUR">EUR</SelectItem>
                                  <SelectItem value="AUD">AUD</SelectItem>
                                  <SelectItem value="GBP">GBP</SelectItem>
                                  <SelectItem value="LBP">LBP</SelectItem>
                                </SelectContent>
                              </Select>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() => handleRemoveAdditionalCharge(charge.id)}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                            <Input
                              type="number"
                              step="0.01"
                              placeholder="Amount"
                              value={charge.amount}
                              onChange={(e) => handleUpdateAdditionalCharge(charge.id, "amount", e.target.value)}
                            />
                            {charge.currencyCode !== "USD" && (
                              <p className="text-xs text-muted-foreground">
                                {charge.fxRateLoading
                                  ? "Fetching exchange rate…"
                                  : parseFloat(charge.fxRate) > 0
                                    ? `1 ${charge.currencyCode} = ${formatNumber(parseFloat(charge.fxRate))} USD`
                                    : "Exchange rate unavailable — will use container FX rate"}
                              </p>
                            )}
                            <AccountCombobox
                              value={charge.ledgerAccountId}
                              onValueChange={(v) => handleUpdateAdditionalCharge(charge.id, "ledgerAccountId", v)}
                              accounts={ledgerAccounts}
                              suppliers={factorySuppliers}
                              placeholder="Select account"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <h3 className="font-semibold text-sm">Duty Details</h3>
                  <div className="space-y-2">
                    <Label>Duty Amount (USD)</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={dutyAmount}
                      onChange={(e) => setDutyAmount(e.target.value)}
                    />
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch checked={dutyPending} onCheckedChange={setDutyPending} />
                    <Label>Duty Payment Pending</Label>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Warning: commission FX rate couldn't be resolved — user can still submit;
              server will validate and return an error if the rate is truly missing. */}
          {commissionFromContainer &&
            containerCommissionCcy !== "USD" &&
            containerCommissionCcy !== currencyCode &&
            !commissionFxRateLoading &&
            !(parseFloat(commissionFxRate) > 0) && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Could not fetch the {containerCommissionCcy}/USD exchange rate automatically. The offload will be
                validated by the server — if it fails, check that an exchange rate is configured for{" "}
                {containerCommissionCcy}.
              </div>
            )}

          {estimatedAvgCostKg !== null && estimatedAvgCostKg > 0 && (
            <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 px-4 py-3 flex items-center justify-between">
              <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
                Estimated Avg Cost / kg
              </span>
              <span className="text-base font-bold font-mono text-emerald-700 dark:text-emerald-200">
                ${estimatedAvgCostKg.toFixed(4)} <span className="text-xs font-normal">USD</span>
              </span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(handleSubmit, "Offload Container")}
              disabled={
                offloadMutation.isPending ||
                !selectedContainerId ||
                // Only block while the commission FX rate is actively fetching.
                // If the fetch completed but returned no rate, the server will
                // validate and return an actionable error — do not silently lock
                // the button with no user-visible explanation.
                (commissionFromContainer &&
                  containerCommissionCcy !== "USD" &&
                  containerCommissionCcy !== currencyCode &&
                  commissionFxRateLoading)
              }
            >
              {offloadMutation.isPending ? "Offloading..." : "Confirm Offload"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
