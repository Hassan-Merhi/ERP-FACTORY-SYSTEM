// Extracted from ./FactoryLoadingDispatchFinance.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";

export type Kind = "BILLABLE" | "INTERNAL" | "DISCOUNT";

export type ErpType = "" | "freight" | "surcharge" | "fumigation" | "documentCharges";

interface Account {
  id: number;
  code: string;
  name: string;
  accountType: string;
}

interface Charge {
  id: number;
  name: string;
  kind: Kind;
  amount: string;
  currency: string;
  ledgerAccountId: number;
  offsetLedgerAccountId: number | null;
  erpChargeType: ErpType | null;
  notes: string | null;
  revision: number;
  lockedAt?: string | null;
}

interface SignedSource {
  sourceFingerprint: string;
  baleCount: number;
  totalWeightKg: string;
  goodsSubtotal: string;
  closureRevision: number;
  bales: Array<{ baleId: number; articleCode: string; lineTotal: string }>;
}

interface Preview {
  status: string;
  currency: string;
  revision: number;
  source: SignedSource | null;
  sourceError: { code: string; message: string } | null;
  totals: {
    goodsSubtotal: string;
    billableChargesTotal: string;
    discountTotal: string;
    internalExpenseTotal: string;
    customerTotal: string;
    chargeCount: number;
  } | null;
  charges: Charge[];
  chargeFingerprint: string;
  accounts: Account[];
  canEdit: boolean;
  postingEnabled: boolean;
  postingNotice: string;
}

export interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  status: string;
  role: string;
}

interface ChargeForm {
  name: string;
  kind: Kind;
  amount: string;
  ledgerAccountId: string;
  offsetLedgerAccountId: string;
  notes: string;
}

const emptyForm = (): ChargeForm => ({
  name: "",
  kind: "BILLABLE",
  amount: "",
  ledgerAccountId: "",
  offsetLedgerAccountId: "",
  notes: "",
});

export const roleCanManage = (role: string) => ["admin", "owner", "developer"].includes(role.trim().toLowerCase());

const acceptsOffset = (type: string) => /liability|payable|accrual|clearing/i.test(type);

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || "Unable to load trip charges");
  return body as T;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unable to save financial charge";
}

export function useFactoryLoadingDispatchFinanceState({ orderId, dispatchId, companyId, status, role }: Props) {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<ChargeForm>(emptyForm());
  const base = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/" + dispatchId;
  const url = base + "/financial-preview";
  const enabled = Boolean(companyId) && status === "CLOSED" && roleCanManage(role);
  const preview = useQuery<Preview>({
    queryKey: companyQueryKey(url, companyId),
    queryFn: () => readJson<Preview>(url),
    enabled,
    staleTime: 5000,
    refetchInterval: formOpen ? false : 15000,
  });
  const data = preview.data;
  const canEdit = enabled && Boolean(data?.canEdit) && data?.status !== "POSTED" && data?.status !== "CONSOLIDATED";
  // The API already scopes these to active, visible accounts in the selected
  // Factory company. Let the operator select any ledger account type instead
  // of silently restricting customer charges to income accounts.
  const mainAccounts = data?.accounts ?? [];
  const offsetAccounts = (data?.accounts ?? []).filter((a) => acceptsOffset(a.accountType));
  const validForm =
    form.name.trim().length > 0 &&
    form.name.trim().length <= 160 &&
    /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(form.amount.trim()) &&
    Number(form.amount) > 0 &&
    Number(form.ledgerAccountId) > 0 &&
    (form.kind !== "INTERNAL" || Number(form.offsetLedgerAccountId) > 0);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: companyQueryKey(url, companyId) });
  }
  function beginCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setFormOpen(true);
  }
  function beginEdit(c: Charge) {
    setEditingId(c.id);
    setForm({
      name: c.name,
      kind: c.kind,
      amount: c.amount,
      ledgerAccountId: String(c.ledgerAccountId),
      offsetLedgerAccountId: c.offsetLedgerAccountId ? String(c.offsetLedgerAccountId) : "",
      notes: c.notes ?? "",
    });
    setFormOpen(true);
  }
  const save = useMutation({
    mutationFn: async (payload: ChargeForm) => {
      if (!data?.source || !data.canEdit) throw new Error("Refresh the signed financial preview before saving");
      const path = editingId === null ? base + "/financial-charges" : base + "/financial-charges/" + editingId;
      const response = await apiRequest(editingId === null ? "POST" : "PATCH", path, {
        expectedChargeFingerprint: data.chargeFingerprint,
        expectedSourceFingerprint: data.source.sourceFingerprint,
        charge: {
          name: payload.name.trim(),
          kind: payload.kind,
          amount: payload.amount,
          ledgerAccountId: Number(payload.ledgerAccountId),
          offsetLedgerAccountId: payload.kind === "INTERNAL" ? Number(payload.offsetLedgerAccountId) : null,
          erpChargeType: null,
          notes: payload.notes.trim() || null,
        },
      });
      return response.json();
    },
    onSuccess: () => {
      setFormOpen(false);
      setEditingId(null);
      setForm(emptyForm());
      invalidate();
      toast({ title: "Trip charge saved", description: "Draft only — no voucher or balance posted." });
    },
    onError: (error) => {
      invalidate();
      toast({ title: "Could not save charge", description: errorMessage(error), variant: "destructive" });
    },
  });
  const remove = useMutation({
    mutationFn: async (chargeId: number) => {
      if (!data?.source || !data.canEdit) throw new Error("Refresh financial preview before deleting");
      const response = await apiRequest("DELETE", base + "/financial-charges/" + chargeId, {
        expectedChargeFingerprint: data.chargeFingerprint,
        expectedSourceFingerprint: data.source.sourceFingerprint,
      });
      return response.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Draft charge removed" });
    },
    onError: (error) => {
      invalidate();
      toast({ title: "Could not delete charge", description: errorMessage(error), variant: "destructive" });
    },
  });
  const busy = save.isPending || remove.isPending;
  return {
    beginCreate,
    beginEdit,
    busy,
    canEdit,
    data,
    editingId,
    enabled,
    form,
    formOpen,
    mainAccounts,
    offsetAccounts,
    preview,
    remove,
    role,
    save,
    setEditingId,
    setForm,
    setFormOpen,
    status,
    validForm,
  };
}
