import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, invalidateCustomerBalances, keyStartsWith } from "@/lib/queryClient";
import { invalidateLocationInventoryQueries } from "@/api/inventoryApi";
import { removePosDraftSummary, upsertPosDraftSummary } from "@/api/posApi";
import type { InvoiceSale } from "../pos-components/InvoiceTemplate";
import type { Location, PosEditVoucher, PosSaleItemPayload, PosSalePayload, SaleRow } from "../pos-components/posTypes";

const GOLDEN_COAST_PHASE6_READINESS = "/api/sp/golden-coast/phase6/pos-sale/readiness";
const GOLDEN_COAST_PHASE6_SALE = "/api/sp/golden-coast/phase6/pos-sale";
const GOLDEN_COAST_PHASE7_READINESS = "/api/sp/golden-coast/phase7/sales-cash-transfer/readiness";

interface GoldenCoastPhase6ReadinessResponse {
  automaticHadiPair?: { hadiCompanyId?: number | string | null } | null;
  code?: string;
  message?: string;
}

interface GoldenCoastPhase6Posting {
  role?: string;
  voucher?: { voucherNumber?: string };
}

interface GoldenCoastPhase6SaleResponse {
  postings?: GoldenCoastPhase6Posting[];
  revenueUsd?: string | number | null;
  automaticHadiCollection?: unknown;
}

interface Phase6PosSaleData {
  voucherDate: string;
  notes?: string;
  clientSaleId?: string;
  items: PosSaleItemPayload[];
}

interface UsePosMutationsParams {
  activeLocation: Location | null;
  editVoucherId?: string;
  editVoucher?: PosEditVoucher | null;
  isSpCompany?: boolean;
  isGoldenCoastPhase6?: boolean;
  goldenCoastParentCompanyId?: number | null;
  clientSaleIdRef: React.MutableRefObject<string>;
  rows: SaleRow[];
  isCreditSale: boolean;
  paymentAccountType: string;
  paymentAccountId: string | null;
  selectedCustomerId: string;
  currentDraftId: number | null;
  notes: string;
  lastSavedFingerprintRef: React.MutableRefObject<string>;
  setSavedSale: (sale: InvoiceSale | null) => void;
  setSaleJustCompleted: (v: boolean) => void;
  setShowPrintDialog: (v: boolean) => void;
  setCurrentDraftId: (id: number | null) => void;
  setLastAutosaved: (date: Date | null) => void;
  setPendingAutoSend: (val: { voucherId: number; locationId: number } | null) => void;
  setPendingStockSend: (val: boolean) => void;
  setStockWaStatus: (s: "idle" | "sending" | "sent" | "failed" | "not_configured") => void;
  toast: (opts: { title: string; description?: string; variant?: "destructive" | "default" }) => void;
  refetchDrafts?: () => void;
}

async function readOptionalJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function phase6PosResult(
  raw: GoldenCoastPhase6SaleResponse,
  saleData: Phase6PosSaleData,
  activeLocation: Location | null,
  rows: SaleRow[]
) {
  const revenuePosting = raw.postings?.find((posting) => posting.role === "revenue") ?? null;
  const voucher = revenuePosting?.voucher ?? null;
  const grandTotal = Number(raw.revenueUsd ?? 0);

  return {
    voucher,
    location: activeLocation,
    items: saleData.items.map((item) => {
      const sourceRow = rows.find((row) => Number(row.stockItemId) === Number(item.stockItemId));
      const quantity = String(item.quantity);
      const rate = Number(item.rate).toFixed(2);
      return {
        stockItemId: item.stockItemId,
        stockItemName: sourceRow?.itemName || "",
        stockItemCode: sourceRow?.stockItemCode || "",
        quantity,
        rate,
        rateUSD: rate,
        sellingPrice: rate,
        configuredPrice: sourceRow?.configuredPrice,
        amount: (Number(quantity) * Number(rate)).toFixed(2),
      };
    }),
    grandTotal: Number.isFinite(grandTotal) ? grandTotal.toFixed(2) : "0.00",
    voucherNumber: voucher?.voucherNumber ?? "",
    saleDate: saleData.voucherDate,
    isCreditSale: false,
    customer: { id: null, code: null, name: (saleData.notes || "").trim() || "Walk-in Customer" },
    automaticHadiCollection: raw.automaticHadiCollection ?? null,
  };
}

export function usePosMutations({
  activeLocation,
  editVoucherId,
  editVoucher,
  isSpCompany,
  isGoldenCoastPhase6,
  goldenCoastParentCompanyId,
  clientSaleIdRef,
  rows,
  isCreditSale,
  paymentAccountType,
  paymentAccountId,
  selectedCustomerId,
  currentDraftId,
  notes,
  lastSavedFingerprintRef,
  setSavedSale,
  setSaleJustCompleted,
  setShowPrintDialog,
  setCurrentDraftId,
  setLastAutosaved,
  setPendingAutoSend,
  setPendingStockSend,
  setStockWaStatus,
  toast,
}: UsePosMutationsParams) {
  const saveMutation = useMutation({
    mutationFn: async (saleData: PosSalePayload) => {
      if (editVoucherId) {
        const updateData = {
          description: saleData.notes,
          locationId: saleData.locationId,
          paymentAccountType: saleData.paymentAccountType,
          paymentAccountId: saleData.paymentAccountId,
          isCreditSale: saleData.isCreditSale,
          voucherDate: saleData.voucherDate,
          currency: saleData.currency,
          items: saleData.items.map((item: PosSaleItemPayload) => ({
            id: item.salesItemId,
            stockItemId: item.stockItemId,
            quantity: String(item.quantity),
            sellingPrice: String(item.rate),
          })),
        };
        const res = await apiRequest("PUT", `/api/vouchers/${editVoucherId}/sales`, {
          ...updateData,
          targetCompanyId: goldenCoastParentCompanyId ?? undefined,
        });
        return res.json();
      }

      if (isSpCompany && isGoldenCoastPhase6) {
        const res = await apiRequest("POST", "/api/pos/sales", {
          ...saleData,
          targetCompanyId: goldenCoastParentCompanyId ?? undefined,
        });
        return res.json();
      }

      if (isSpCompany) {
        // Supplier Partner is a shared company type, so determine whether this
        // company is Golden Coast from the server-owned accounting setup. A
        // Golden Coast response also gives us the configured HADI parent id;
        // sending it as targetCompanyId lets the global tenant boundary verify
        // membership before the atomic cross-company sale starts.
        const readinessResponse = await fetch(GOLDEN_COAST_PHASE6_READINESS, { credentials: "include" });
        const readiness = await readOptionalJson<GoldenCoastPhase6ReadinessResponse>(readinessResponse);

        if (readinessResponse.ok) {
          const hadiCompanyId = Number(readiness?.automaticHadiPair?.hadiCompanyId ?? 0);
          if (!Number.isInteger(hadiCompanyId) || hadiCompanyId <= 0) {
            throw new Error("Golden Coast POS is not ready for automatic HADI cash routing.");
          }
          if (!saleData.clientSaleId) {
            throw new Error("Golden Coast POS requires a stable client sale id.");
          }

          const phase6Body = {
            locationId: saleData.locationId,
            saleDate: saleData.voucherDate,
            customerName: (saleData.notes || "").trim() || "Walk-in Customer",
            clientRequestId: String(saleData.clientSaleId),
            notes: saleData.notes || undefined,
            lines: (saleData.items as PosSaleItemPayload[]).map((item) => ({
              stockItemId: item.stockItemId,
              qty: String(item.quantity),
              unitPriceUsd: Number(item.rate).toFixed(2),
            })),
          };
          const res = await apiRequest(
            "POST",
            `${GOLDEN_COAST_PHASE6_SALE}?targetCompanyId=${encodeURIComponent(String(hadiCompanyId))}`,
            phase6Body
          );
          const raw = (await res.json()) as GoldenCoastPhase6SaleResponse;
          return phase6PosResult(raw, saleData as Phase6PosSaleData, activeLocation, rows);
        }

        // A 409 with this exact code means the Supplier Partner is not Golden
        // Coast and should continue using the generic SP sales workflow. Every
        // other readiness error is fail-closed so Golden Coast can never drift
        // back to legacy accounting because setup/HADI is unhealthy.
        if (readinessResponse.status !== 409 || readiness?.code !== "GC_PHASE6_NOT_CONFIGURED") {
          throw new Error(readiness?.message || "Unable to verify Golden Coast POS accounting readiness.");
        }

        const spBody = {
          saleDate: saleData.voucherDate,
          customerName: (saleData.notes || "").trim() || "Walk-in Customer",
          paymentAccountType: saleData.paymentAccountType,
          paymentAccountId: saleData.paymentAccountId,
          notes: saleData.notes || undefined,
          saleLines: saleData.items.map((item: PosSaleItemPayload) => ({
            stockItemId: item.stockItemId,
            qtySold: String(item.quantity),
            salePricePerUnit: String(item.rate),
          })),
        };
        const res = await apiRequest("POST", "/api/sp/sales", spBody);
        const raw = (await res.json()) as {
          id?: number;
          voucherId?: number;
          totalSalePriceUsd?: string;
          saleDate?: string;
          customerName?: string;
          lines?: Array<{
            stockItemId?: number;
            description?: string;
            articleCode?: string;
            qtySold?: string;
            salePricePerUnit?: string;
            saleTotal?: string;
          }>;
        };
        const grandTotal = parseFloat(raw.totalSalePriceUsd || "0");
        const voucherNumber = `SP-SALE-${raw.id}`;
        return {
          voucher: { id: raw.voucherId, voucherNumber, customerId: undefined },
          location: activeLocation,
          items: (raw.lines || []).map((l) => ({
            stockItemId: l.stockItemId,
            stockItemName: l.description || l.articleCode,
            stockItemCode: l.articleCode,
            quantity: l.qtySold,
            rate: l.salePricePerUnit,
            rateUSD: l.salePricePerUnit,
            sellingPrice: l.salePricePerUnit,
            configuredPrice: l.salePricePerUnit,
            amount: l.saleTotal,
          })),
          grandTotal: grandTotal.toFixed(2),
          voucherNumber,
          saleDate: raw.saleDate,
          isCreditSale: false,
          customer: { id: null, code: null, name: raw.customerName },
        };
      }

      const res = await apiRequest("POST", "/api/pos/sales", saleData);
      return res.json();
    },
    onSuccess: async (data) => {
      clientSaleIdRef.current = crypto.randomUUID();
      setSavedSale(data as InvoiceSale);
      if (!editVoucherId) setSaleJustCompleted(true);

      const locationId = activeLocation?.id || data.location?.id || editVoucher?.locationId;
      if (isSpCompany) {
        queryClient.invalidateQueries({ queryKey: ["/api/sp/stock"] });
        queryClient.invalidateQueries({ queryKey: [GOLDEN_COAST_PHASE7_READINESS] });
      } else invalidateLocationInventoryQueries(locationId);
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      if (editVoucherId) queryClient.invalidateQueries({ queryKey: [`/api/vouchers/${editVoucherId}`] });
      if (isSpCompany) {
        queryClient.invalidateQueries({ predicate: keyStartsWith("/api/sp/report/profit") });
      }
      invalidateCustomerBalances(data?.voucher?.customerId ?? undefined);

      toast({
        title: editVoucherId ? "Sale Updated" : "Sale Saved",
        description: `Sale ${data.voucher?.voucherNumber} has been ${editVoucherId ? "updated" : "saved"} successfully.`,
      });
      setShowPrintDialog(true);

      if (!editVoucherId) {
        const waGroupId =
          (activeLocation as unknown as (Location | null) & { whatsappGroupChatId: unknown })?.whatsappGroupChatId ||
          (data.location as unknown as { whatsappGroupChatId: unknown })?.whatsappGroupChatId;
        if (waGroupId && data.voucher?.id) {
          setPendingAutoSend({ voucherId: data.voucher.id, locationId: activeLocation?.id || data.location?.id });
          setStockWaStatus("sending");
          setTimeout(() => setPendingStockSend(true), 3000);
        } else {
          setStockWaStatus("not_configured");
        }
      }
    },
    onError: (error: ClientErrorLike) => {
      if (isGoldenCoastPhase6 && error.code === "POSTING_IDEMPOTENCY_CONFLICT") {
        clientSaleIdRef.current = crypto.randomUUID();
        toast({
          title: "Sale request refreshed",
          description: "The previous sale request no longer matches these items. Please click Save again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Error",
        description: error.message || `Failed to ${editVoucherId ? "update" : "save"} sale`,
        variant: "destructive",
      });
    },
  });

  const deleteDraftMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/pos/drafts/${id}`),
    onSuccess: (_data, draftId) => {
      removePosDraftSummary(activeLocation?.id, draftId);
      toast({ title: "Draft Deleted", description: "Draft has been deleted successfully" });
    },
  });

  const saveDraftMutation = useMutation({
    mutationFn: async () => {
      if (!activeLocation) throw new Error("No location selected");
      const validItems = rows.filter((r) => r.stockItemId && r.quantity > 0 && r.rate > 0);
      if (validItems.length === 0) throw new Error("No items to save");
      const draftData = {
        locationId: activeLocation.id,
        paymentAccountType: isCreditSale ? "credit" : paymentAccountType,
        paymentAccountId: isCreditSale
          ? selectedCustomerId
            ? parseInt(selectedCustomerId)
            : null
          : paymentAccountId
            ? parseInt(paymentAccountId)
            : null,
        isCreditSale,
        notes,
        items: validItems.map((row) => ({
          stockItemId: row.stockItemId,
          quantity: row.quantity.toString(),
          rate: row.rate.toString(),
          amount: row.amount.toString(),
        })),
      };
      if (currentDraftId) {
        const res = await apiRequest("PATCH", `/api/pos/drafts/${currentDraftId}`, draftData);
        return res.json();
      }
      const res = await apiRequest("POST", "/api/pos/drafts", draftData);
      return res.json();
    },
    onSuccess: (data) => {
      setCurrentDraftId(data.id);
      setLastAutosaved(new Date());
      const validItems = rows.filter((r) => r.stockItemId && r.quantity > 0 && r.rate > 0);
      upsertPosDraftSummary(activeLocation?.id, data, validItems);
      lastSavedFingerprintRef.current = JSON.stringify({
        items: validItems.map((r) => ({ id: r.stockItemId, qty: r.quantity, rate: r.rate })),
        notes,
        isCreditSale,
        paymentAccountType,
        paymentAccountId,
        selectedCustomerId,
      });
      toast({ title: "Draft Saved", description: "Your transaction has been saved as a draft" });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message || "Failed to save draft", variant: "destructive" });
    },
  });

  return { saveMutation, deleteDraftMutation, saveDraftMutation };
}
