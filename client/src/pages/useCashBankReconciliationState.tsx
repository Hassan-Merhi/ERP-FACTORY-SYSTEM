// Extracted from ./CashBankReconciliation.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  exact,
  json,
  upload,
  type Account,
  type Detail,
  type Preview,
  type Statement,
} from "./CashBankReconciliationTypes";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

export function useCashBankReconciliationState() {
  const [location] = useLocation();
  const factory = location.startsWith("/factory/");
  const properties = location.startsWith("/properties/");
  const createPath = factory ? "/factory/create" : properties ? "/properties/create" : "/create";
  const voucherPath = (voucherId: number) =>
    factory
      ? `/factory/voucher-detail/${voucherId}`
      : properties
        ? `/properties/voucher-detail/${voucherId}`
        : `/voucher-detail/${voucherId}`;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const accounts = useQuery<Account[]>({
    queryKey: ["/api/accounting/cash-bank/accounts"],
    queryFn: () => json("/api/accounting/cash-bank/accounts"),
    retry: false,
  });
  const [account, setAccount] = useState("");
  const current = useMemo(
    () => accounts.data?.find((a) => `${a.accountKind}:${a.accountId}` === account),
    [account, accounts.data]
  );
  const [statementId, setStatementId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState({
    currency: "USD",
    periodStart: "",
    periodEnd: "",
    openingBalance: "",
    closingBalance: "",
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const [reviewCategory, setReviewCategory] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const listUrl = current
    ? `/api/accounting/cash-bank/statements?accountKind=${current.accountKind}&accountId=${current.accountId}`
    : null;
  const statements = useQuery<Statement[]>({
    queryKey: ["cash-bank-statements", listUrl],
    queryFn: () => json(listUrl!),
    enabled: !!listUrl,
    retry: false,
  });
  const detail = useQuery<Detail>({
    queryKey: ["cash-bank-detail", statementId],
    queryFn: () => json(`/api/accounting/cash-bank/statements/${statementId}`),
    enabled: !!statementId,
    retry: false,
  });
  const buildForm = () => {
    if (!current || !file) throw new Error("Select an account and a CSV/XLSX statement first");
    const data = new FormData();
    data.set("file", file);
    data.set("accountKind", current.accountKind);
    data.set("accountId", String(current.accountId));
    for (const [k, v] of Object.entries(form)) data.set(k, v);
    return data;
  };
  const previewMutation = useMutation({
    mutationFn: () => upload("/api/accounting/cash-bank/preview", buildForm()) as Promise<Preview>,
    onSuccess: (out) => setPreview(out),
    onError: (error: Error) =>
      toast({ title: "Statement preview failed", description: error.message, variant: "destructive" }),
  });
  const importMutation = useMutation({
    mutationFn: () => upload("/api/accounting/cash-bank/import", buildForm()) as Promise<{ statementId: number }>,
    onSuccess: async (out) => {
      toast({ title: "Statement imported (no ledger vouchers created)" });
      setStatementId(out.statementId);
      setPreview(null);
      setFile(null);
      await queryClient.invalidateQueries({ queryKey: ["cash-bank-statements"] });
      await queryClient.invalidateQueries({ queryKey: ["cash-bank-detail"] });
    },
    onError: (error: Error) => toast({ title: "Import refused", description: error.message, variant: "destructive" }),
  });
  const matchMutation = useMutation({
    mutationFn: async () => {
      if (!selectedLine || !selectedEntry) throw new Error("Select one statement line and one voucher entry");
      const response = await apiRequest("POST", "/api/accounting/cash-bank/matches", {
        statementLineId: selectedLine,
        voucherEntryId: selectedEntry,
        reason: reason || null,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({ title: "Bank movement matched", description: "Existing accounting vouchers were not changed" });
      setSelectedLine(null);
      setSelectedEntry(null);
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["cash-bank-detail"] });
    },
    onError: (error: Error) => toast({ title: "Match refused", description: error.message, variant: "destructive" }),
  });
  const reviewMutation = useMutation({
    mutationFn: async () => {
      if (!selectedLine) throw new Error("Select a statement movement first");
      const result = await apiRequest("POST", `/api/accounting/cash-bank/lines/${selectedLine}/review`, {
        category: reviewCategory || null,
        note: reviewNote || null,
      });
      return result.json();
    },
    onSuccess: async () => {
      toast({
        title: "Bank transaction reviewed",
        description: "This classification does not post an accounting voucher",
      });
      await queryClient.invalidateQueries({ queryKey: ["cash-bank-detail"] });
    },
    onError: (error: Error) => toast({ title: "Review not saved", description: error.message, variant: "destructive" }),
  });
  const unmatchMutation = useMutation({
    mutationFn: async (matchId: number) => {
      const response = await apiRequest("POST", `/api/accounting/cash-bank/matches/${matchId}/void`, {
        reason: voidReason,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({ title: "Match cancelled", description: "The statement and voucher were preserved" });
      setVoidReason("");
      await queryClient.invalidateQueries({ queryKey: ["cash-bank-detail"] });
    },
    onError: (error: Error) => toast({ title: "Unmatch refused", description: error.message, variant: "destructive" }),
  });
  const selected = detail.data?.lines.find((l) => l.id === selectedLine);
  const suggestions = (detail.data?.bookEntries ?? []).filter(
    (e) => e.eligible && selected && exact(e.amount, selected.amount) && e.currency === detail.data?.statement.currency
  );
  const chosen = detail.data?.bookEntries.find((e) => e.entryId === selectedEntry);
  const matchesValid =
    !!selected &&
    selected.status !== "matched" &&
    !!chosen &&
    chosen.eligible &&
    exact(selected.amount, chosen.amount) &&
    chosen.currency === detail.data?.statement.currency;
  const busy = previewMutation.isPending || importMutation.isPending;
  return {
    account,
    accounts,
    busy,
    createPath,
    current,
    detail,
    file,
    form,
    importMutation,
    matchMutation,
    matchesValid,
    preview,
    previewMutation,
    reason,
    reviewCategory,
    reviewMutation,
    reviewNote,
    selected,
    selectedEntry,
    selectedLine,
    setAccount,
    setFile,
    setForm,
    setPreview,
    setReason,
    setReviewCategory,
    setReviewNote,
    setSelectedEntry,
    setSelectedLine,
    setStatementId,
    setVoidReason,
    statementId,
    statements,
    suggestions,
    unmatchMutation,
    voidReason,
    voucherPath,
  };
}

export function CashBankReconciliationSection({
  reviewCategory,
  reviewMutation,
  reviewNote,
  selectedLine,
  setReviewCategory,
  setReviewNote,
}: Pick<
  ReturnType<typeof useCashBankReconciliationState>,
  "reviewCategory" | "reviewMutation" | "reviewNote" | "selectedLine" | "setReviewCategory" | "setReviewNote"
>) {
  return (
    <div className="rounded-md border p-3 space-y-2">
      <Label>Classify selected transaction (no accounting posting)</Label>
      <Select
        value={reviewCategory || "__none__"}
        onValueChange={(value) => setReviewCategory(value === "__none__" ? "" : value)}
        disabled={!selectedLine}
      >
        <SelectTrigger className="h-9 w-full text-sm" aria-label="Review category">
          <SelectValue placeholder="Not classified" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">Not classified</SelectItem>
          <SelectItem value="bank_fee">Bank fee / charge</SelectItem>
          <SelectItem value="transfer">Bank / cash transfer</SelectItem>
          <SelectItem value="unidentified_receipt">Unidentified receipt</SelectItem>
          <SelectItem value="unidentified_payment">Unidentified payment</SelectItem>
          <SelectItem value="other">Other investigation</SelectItem>
        </SelectContent>
      </Select>
      <Input
        placeholder="Investigation note"
        disabled={!selectedLine}
        value={reviewNote}
        onChange={(e) => setReviewNote(e.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!selectedLine || reviewMutation.isPending}
        onClick={() => reviewMutation.mutate()}
      >
        Save review
      </Button>
    </div>
  );
}
