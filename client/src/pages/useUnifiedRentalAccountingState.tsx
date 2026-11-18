// Extracted from ./UnifiedRentalAccounting.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

type Mod = "ERP" | "FACTORY" | "PROPERTIES";

type Contract = {
  id: number;
  unitId: number;
  unitNumber: string;
  unitType: string;
  locationGroup: string;
  tenantName: string;
  status: string;
  currency: string;
  monthlyRent: string;
  startDate: string;
  endDate: string | null;
  internal: boolean;
  perspective?: "TENANT" | "LANDLORD";
  linkedCompanyId: number | null;
};

type Contracts = { module: Mod; perspective: "MIXED_BY_CONTRACT"; contracts: Contract[]; limitedTo: number };

type Period = {
  ledgerRowId: number | null;
  year: number;
  month: number;
  dueDate: string;
  expected: string;
  paid: string;
  outstanding: string;
  overpayment: string;
  scheduled: string;
  accrualVoucherId: number | null;
  accrualStale: boolean;
  usedPrepaidAccount: boolean;
  usedAdvanceAccount: boolean;
  cachedPaid: string | null;
  cacheDifference: string | null;
  status: string;
  postedPaymentIds: number[];
};

export type Payment = {
  id: number;
  date: string;
  period: string;
  status: string;
  amount: string;
  currency: string;
  historicalRate: string;
  voucherId: number | null;
  voucherNumber: string | null;
  groupId: string | null;
  isGuaranteeActivity: boolean;
  ledgerRowId: number | null;
};

export type Guarantee = {
  contractPledgeNative: string;
  statementFlag: boolean;
  statedPostedNative: string | null;
  ledgerEvidenceUsd: string;
  vouchers: Array<{
    voucherId: number;
    voucherNumber: string;
    date: string;
    accountCode: string | null;
    signedUsd: string;
  }>;
};

export type Expense = {
  id: number;
  voucherId: number;
  voucherNumber: string | null;
  category: string;
  amountUsd: string;
  note: string | null;
  sourceStatus: "active" | "reversed" | "retired" | "optional";
};

type Detail = {
  module: Mod;
  perspective: "TENANT" | "LANDLORD";
  asOfDate: string;
  contract: Contract;
  totals: {
    expectedDue: string;
    postedAgainstDue: string;
    outstanding: string;
    advanceFuturePeriods: string;
    scheduledNotPosted: string;
    maintenanceExpensesBaseUsd: string;
    depositPledgeNative: string;
    depositBalanceEvidenceUsd: string;
  };
  periods: Period[];
  payments: Payment[];
  guarantee: Guarantee;
  expenses: Expense[];
  warnings: string[];
  limitations: Record<string, string>;
};

type Category = "maintenance" | "repairs" | "utilities" | "insurance" | "property_tax" | "other_property_cost";

const CATEGORIES: Category[] = [
  "maintenance",
  "repairs",
  "utilities",
  "insurance",
  "property_tax",
  "other_property_cost",
];

async function get<T>(u: string): Promise<T> {
  const res = await fetch(u, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? "Rental accounting unavailable");
  return data as T;
}

export const name = (v: string) => v.replaceAll("_", " ").replace(/\b\w/g, (x) => x.toUpperCase());

export function useUnifiedRentalAccountingState() {
  const [path] = useLocation();
  const mod: Mod = path.startsWith("/factory/") ? "FACTORY" : path.startsWith("/properties/") ? "PROPERTIES" : "ERP";
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const { toast } = useToast();
  const client = useQueryClient();
  const [id, setId] = useState("");
  const [asOf, setAsOf] = useState("");
  const [category, setCategory] = useState<Category>("maintenance");
  const [voucher, setVoucher] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [showPayments, setShowPayments] = useState(false);
  const list = useQuery<Contracts>({
    queryKey: ["/api/accounting/rentals/contracts", companyId, mod],
    queryFn: () => get("/api/accounting/rentals/contracts?module=" + mod),
    enabled: !!companyId,
    retry: false,
  });
  const selectedId = Number(id);
  const active = Number.isSafeInteger(selectedId) && selectedId > 0;
  const detail = useQuery<Detail>({
    queryKey: ["/api/accounting/rentals/contracts", companyId, mod, id, asOf],
    queryFn: () =>
      get(`/api/accounting/rentals/contracts/${selectedId}?module=${mod}${asOf ? "&asOfDate=" + asOf : ""}`),
    enabled: !!companyId && active,
    retry: false,
  });
  const post = useMutation({
    mutationFn: async () => {
      if (!active) throw new Error("Choose a contract");
      const r = await apiRequest("POST", "/api/accounting/rentals/expense-links", {
        module: mod,
        contractId: selectedId,
        voucherId: Number(voucher),
        category,
        amountUsd: amount,
        clientRequestKey: requestId,
        note: note.trim() || null,
      });
      return r.json();
    },
    onSuccess: async () => {
      toast({ title: "Expense attributed", description: "Voucher and its ledger amounts remain unchanged" });
      setVoucher("");
      setAmount("");
      setNote("");
      setRequestId(crypto.randomUUID());
      await client.invalidateQueries({ queryKey: ["/api/accounting/rentals/contracts"] });
    },
    onError: (e: Error) => toast({ title: "Allocation refused", description: e.message, variant: "destructive" }),
  });
  const voidLink = useMutation({
    mutationFn: async (linkId: number) => {
      const r = await apiRequest("POST", `/api/accounting/rentals/expense-links/${linkId}/void`, {
        reason: voidReason,
      });
      return r.json();
    },
    onSuccess: async () => {
      toast({ title: "Expense link cancelled", description: "Original financial voucher preserved" });
      setVoidReason("");
      await client.invalidateQueries({ queryKey: ["/api/accounting/rentals/contracts"] });
    },
    onError: (e: Error) => toast({ title: "Cannot cancel link", description: e.message, variant: "destructive" }),
  });
  const voucherLink = (n: number) =>
    mod === "FACTORY"
      ? `/factory/voucher-detail/${n}`
      : mod === "PROPERTIES"
        ? `/properties/voucher-detail/${n}`
        : `/voucher-detail/${n}`;
  const totals = detail.data?.totals;
  return {
    amount,
    asOf,
    category,
    detail,
    id,
    list,
    note,
    post,
    setAmount,
    setAsOf,
    setCategory,
    setId,
    setNote,
    setRequestId,
    setShowPayments,
    setVoidReason,
    setVoucher,
    showPayments,
    totals,
    voidLink,
    voidReason,
    voucher,
    voucherLink,
  };
}

export function UnifiedRentalAccountingSection({
  amount,
  category,
  note,
  setAmount,
  setCategory,
  setNote,
  setRequestId,
  setVoucher,
  voucher,
}: Pick<
  ReturnType<typeof useUnifiedRentalAccountingState>,
  "amount" | "category" | "note" | "setAmount" | "setCategory" | "setNote" | "setRequestId" | "setVoucher" | "voucher"
>) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div>
        <Label>Posted voucher ID</Label>
        <Input
          type="number"
          min="1"
          value={voucher}
          onChange={(e) => {
            setVoucher(e.target.value);
            setRequestId(crypto.randomUUID());
          }}
          placeholder="Voucher ID"
        />
      </div>
      <div>
        <Label>Allocated USD base amount</Label>
        <Input
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setRequestId(crypto.randomUUID());
          }}
          placeholder="e.g. 125.00"
        />
      </div>
      <div>
        <Label>Expense category</Label>
        <Select
          value={category}
          onValueChange={(value) => {
            setCategory(value as Category);
            setRequestId(crypto.randomUUID());
          }}
        >
          <SelectTrigger className="h-10 w-full text-sm" aria-label="Expense category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem value={c} key={c}>
                {name(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="sm:col-span-3">
        <Label>Explanation / property work details</Label>
        <Input
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setRequestId(crypto.randomUUID());
          }}
          placeholder="Optional expense attribution note"
        />
      </div>
    </div>
  );
}

export function UnifiedRentalAccountingCardSection({
  asOf,
  detail,
  id,
  list,
  setAsOf,
  setId,
}: Pick<ReturnType<typeof useUnifiedRentalAccountingState>, "asOf" | "detail" | "id" | "list" | "setAsOf" | "setId">) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Rental contract</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="rent-accounting-contract">Unit / tenant</Label>
          <Select value={id || "__none__"} onValueChange={(value) => setId(value === "__none__" ? "" : value)}>
            <SelectTrigger id="rent-accounting-contract" className="h-10 w-full text-sm">
              <SelectValue placeholder="Select contract..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Select contract...</SelectItem>
              {(list.data?.contracts ?? []).map((c) => (
                <SelectItem value={String(c.id)} key={c.id}>
                  #{c.id} · {c.locationGroup}/{c.unitNumber} · {c.tenantName} ({c.currency}, {c.status},{" "}
                  {c.perspective ?? "lease"})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rent-accounting-date">As-of date</Label>
          <Input id="rent-accounting-date" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        {list.isError && <p className="text-destructive text-sm">{(list.error as Error).message}</p>}
        <div className="sm:col-span-3">
          <Button
            variant="outline"
            onClick={() => {
              detail.refetch();
              list.refetch();
            }}
            disabled={detail.isFetching}
          >
            Refresh rental accounts
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
