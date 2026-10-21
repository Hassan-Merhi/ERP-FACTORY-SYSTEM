/**
 * Unified ERP / Factory / Properties Phase 4 cash and bank reconciliation.
 * This page never adjusts the general ledger; it records statement evidence
 * and lets accountants match one exact bank movement to one posted entry.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Kind = "bank" | "ledger";
type Account = { accountKind: Kind; accountId: number; name: string };
type Statement = {
  id: number;
  currency: string;
  period_start: string;
  period_end: string;
  opening_balance: string;
  closing_balance: string;
  file_name: string;
  imported_at: string;
};
type Line = {
  id: number;
  rowNumber: number;
  date: string;
  amount: string;
  reference: string | null;
  description: string | null;
  matchId: number | null;
  reviewCategory: string | null;
  reviewNote: string | null;
  matchedEntryId: number | null;
  matchedVoucherNumber: string | null;
  matchedVoucherId: number | null;
  status: "matched" | "unmatched" | "stale";
};
type BookEntry = {
  entryId: number;
  voucherId: number;
  voucherNumber: string;
  date: string;
  amount: string;
  currency: string;
  currencyVerified: boolean;
  eligible: boolean;
  matched: boolean;
  matchedToStatementId: number | null;
};
type Balances = {
  currency: string;
  statementOpening: string;
  statementClosing: string;
  statementMovement: string;
  bookOpening: string | null;
  bookClosing: string | null;
  bookVsStatementDifference: string | null;
  unclearedBook: string;
  unmatchedStatement: string;
  adjustedBook: string | null;
  residual: string | null;
  matched: number;
  unmatchedStatementCount: number;
  unclearedBookCount: number;
  openingVerified: boolean;
  unverifiedEntries: number;
  otherCurrencyEntries: number;
  reconcilable: boolean;
};
type Detail = {
  statement: Statement;
  account: { name: string; kind: Kind; id: number; linkedLedgerId: number | null };
  lines: Line[];
  bookEntries: BookEntry[];
  balances: Balances;
};
type Preview = {
  rowCount: number;
  calculatedClosing: string;
  suppliedClosing: string;
  balanced: boolean;
  lines: Array<{ transactionDate: string; signedAmount: string; reference: string | null }>;
};
async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const content = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(content.message ?? "Could not load reconciliation");
  return content as T;
}
async function upload(path: string, body: FormData) {
  const response = await fetch(path, { method: "POST", body, credentials: "include" });
  const output = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(output.message ?? "Statement upload failed");
  return output;
}
function fmt(value: string | null) {
  return value === null ? "Unverified" : value;
}
function exact(a: string, b: string): boolean {
  const aa = Number(a),
    bb = Number(b);
  return Number.isFinite(aa) && Number.isFinite(bb) && Math.abs(aa - bb) < 0.0000005;
}

export default function CashBankReconciliation() {
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

  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="cash-bank-reconciliation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Cash & Bank Reconciliation</h1>
          <p className="text-sm text-muted-foreground">
            ERP · Factory · Rentals — one accounting ledger, imported statement evidence and audited matches.
          </p>
        </div>
        <a className="rounded-md border px-3 py-2 text-sm" href={createPath}>
          Create voucher for an unrecorded bank fee or transfer
        </a>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>1. Choose cash or bank account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="cash-bank-account">Account</Label>
          <select
            id="cash-bank-account"
            value={account}
            className="h-10 w-full rounded-md border bg-background px-2"
            onChange={(e) => {
              setAccount(e.target.value);
              setStatementId(null);
              setSelectedLine(null);
              setPreview(null);
            }}
          >
            <option value="">Choose existing account...</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.accountKind + ":" + a.accountId} value={a.accountKind + ":" + a.accountId}>
                {a.accountKind === "bank" ? "Bank" : "Cash/Bank Ledger"} — {a.name} (#{a.accountId})
              </option>
            ))}
          </select>
          {accounts.isError && <p className="text-sm text-destructive">{(accounts.error as Error).message}</p>}
        </CardContent>
      </Card>
      {current && (
        <Card>
          <CardHeader>
            <CardTitle>2. Import statement (CSV or Excel)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              File headers: Date, Amount (positive receipt / negative payment), Description, Reference, optional
              Balance. Or Date, Debit, Credit. Date format YYYY-MM-DD or DD/MM/YYYY. Maximum 5,000 lines.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label>Currency</Label>
                <Input
                  maxLength={3}
                  value={form.currency}
                  onChange={(e) => {
                    setForm((x) => ({ ...x, currency: e.target.value.toUpperCase() }));
                    setPreview(null);
                  }}
                />
              </div>
              <div>
                <Label>Period start</Label>
                <Input
                  type="date"
                  value={form.periodStart}
                  onChange={(e) => {
                    setForm((x) => ({ ...x, periodStart: e.target.value }));
                    setPreview(null);
                  }}
                />
              </div>
              <div>
                <Label>Period end</Label>
                <Input
                  type="date"
                  value={form.periodEnd}
                  onChange={(e) => {
                    setForm((x) => ({ ...x, periodEnd: e.target.value }));
                    setPreview(null);
                  }}
                />
              </div>
              <div>
                <Label>Statement opening balance</Label>
                <Input
                  value={form.openingBalance}
                  onChange={(e) => {
                    setForm((x) => ({ ...x, openingBalance: e.target.value }));
                    setPreview(null);
                  }}
                />
              </div>
              <div>
                <Label>Statement closing balance</Label>
                <Input
                  value={form.closingBalance}
                  onChange={(e) => {
                    setForm((x) => ({ ...x, closingBalance: e.target.value }));
                    setPreview(null);
                  }}
                />
              </div>
              <div>
                <Label>Statement file</Label>
                <Input
                  type="file"
                  accept=".csv,.xlsx"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setPreview(null);
                  }}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy || !file} onClick={() => previewMutation.mutate()}>
                {previewMutation.isPending ? "Previewing…" : "Preview import"}
              </Button>
              <Button disabled={busy || !file || !preview?.balanced} onClick={() => importMutation.mutate()}>
                {importMutation.isPending ? "Importing…" : "Import balanced statement"}
              </Button>
            </div>
            {preview && (
              <div className="rounded-md border p-3 text-sm space-y-1">
                <p>
                  {preview.rowCount} transactions · Calculated closing: <strong>{preview.calculatedClosing}</strong> ·
                  Stated closing: <strong>{preview.suppliedClosing}</strong>
                </p>
                <p className={preview.balanced ? "text-foreground" : "text-destructive"}>
                  {preview.balanced
                    ? "Amounts reconcile; safe to import as evidence."
                    : "The imported movements do not equal the stated closing balance. Review the file before importing."}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {current && (
        <Card>
          <CardHeader>
            <CardTitle>3. Imported statements</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {statements.isError && <p className="text-destructive text-sm">{(statements.error as Error).message}</p>}
            {!statements.data?.length && (
              <p className="text-sm text-muted-foreground">No statements imported for this account.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {(statements.data ?? []).map((row) => (
                <Button
                  key={row.id}
                  variant={statementId === Number(row.id) ? "default" : "outline"}
                  onClick={() => {
                    setStatementId(Number(row.id));
                    setSelectedLine(null);
                    setSelectedEntry(null);
                  }}
                >
                  #{row.id} · {row.period_end} · {row.currency}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      {detail.isError && (
        <p className="text-sm text-destructive" role="alert">
          {(detail.error as Error).message}
        </p>
      )}
      {detail.data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>4. Statement vs. book balances — {detail.data.statement.currency}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {(
                  [
                    ["Statement opening", detail.data.balances.statementOpening],
                    ["Statement closing", detail.data.balances.statementClosing],
                    ["Ledger opening at period start", detail.data.balances.bookOpening],
                    ["Ledger closing at period end", detail.data.balances.bookClosing],
                    ["Outstanding book movements", detail.data.balances.unclearedBook],
                    ["Unmatched statement movements", detail.data.balances.unmatchedStatement],
                    ["Adjusted book balance", detail.data.balances.adjustedBook],
                    ["Unexplained residual", detail.data.balances.residual],
                  ] as Array<[string, string | null]>
                ).map(([label, value]) => (
                  <div key={label}>
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="font-semibold tabular-nums">{fmt(value)}</p>
                  </div>
                ))}
              </div>
              <p className="text-sm">
                {detail.data.balances.reconcilable
                  ? "All listed statement movements are matched to posted vouchers and balances agree."
                  : "Outstanding or unmatched movements remain. This view makes no automatic accounting adjustment."}
              </p>
              {(!detail.data.balances.openingVerified ||
                detail.data.balances.unverifiedEntries > 0 ||
                detail.data.balances.otherCurrencyEntries > 0) && (
                <p role="alert" className="text-sm text-destructive">
                  Ledger closing balance is withheld: opening currency verified ={" "}
                  {String(detail.data.balances.openingVerified)}; {detail.data.balances.unverifiedEntries}{" "}
                  unverified-currency entries and {detail.data.balances.otherCurrencyEntries} entries in other
                  currencies. Reconciliation cannot be certified from mixed or missing currency evidence.
                </p>
              )}
            </CardContent>
          </Card>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>5. Statement movements</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="max-h-[450px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Date / reference</th>
                        <th className="p-2 text-right">Amount</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.lines.map((line) => (
                        <tr key={line.id} className="border-b">
                          <td className="p-2">
                            {line.date}
                            <div className="text-muted-foreground">{line.reference || line.description}</div>
                          </td>
                          <td className="p-2 text-right tabular-nums">{line.amount}</td>
                          <td className="p-2">
                            {line.status}
                            {line.reviewCategory && (
                              <div className="text-muted-foreground">{line.reviewCategory.replaceAll("_", " ")}</div>
                            )}
                            {line.matchedVoucherId && (
                              <div>
                                <a className="underline" href={voucherPath(line.matchedVoucherId)}>
                                  {line.matchedVoucherNumber}
                                </a>
                              </div>
                            )}
                          </td>
                          <td className="p-2">
                            {line.matchId !== null ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={!voidReason.trim() || unmatchMutation.isPending}
                                onClick={() => unmatchMutation.mutate(line.matchId!)}
                              >
                                Unmatch
                              </Button>
                            ) : (
                              <Button
                                variant={selectedLine === line.id ? "default" : "outline"}
                                size="sm"
                                onClick={() => {
                                  setSelectedLine(line.id);
                                  setSelectedEntry(null);
                                  setReviewCategory(line.reviewCategory ?? "");
                                  setReviewNote(line.reviewNote ?? "");
                                }}
                              >
                                Select
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="rounded-md border p-3 space-y-2">
                  <Label>Classify selected transaction (no accounting posting)</Label>
                  <select
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={reviewCategory}
                    onChange={(e) => setReviewCategory(e.target.value)}
                    disabled={!selectedLine}
                  >
                    <option value="">Not classified</option>
                    <option value="bank_fee">Bank fee / charge</option>
                    <option value="transfer">Bank / cash transfer</option>
                    <option value="unidentified_receipt">Unidentified receipt</option>
                    <option value="unidentified_payment">Unidentified payment</option>
                    <option value="other">Other investigation</option>
                  </select>
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
                <Label>Reason for cancelling a match (required)</Label>
                <Input
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="Why is the match being cancelled?"
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>6. Posted voucher movements</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {selected && (
                  <p className="text-sm">
                    Selected statement line #{selected.id} · {selected.amount} {detail.data.statement.currency}. Exact
                    unmatched voucher candidates appear first.
                  </p>
                )}
                <div className="max-h-[450px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Voucher / date</th>
                        <th className="p-2 text-right">Amount</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...detail.data.bookEntries]
                        .sort((a, b) => {
                          const ax = suggestions.some((x) => x.entryId === a.entryId) ? 0 : 1;
                          const bx = suggestions.some((x) => x.entryId === b.entryId) ? 0 : 1;
                          return ax - bx;
                        })
                        .map((item) => (
                          <tr key={item.entryId} className="border-b">
                            <td className="p-2">
                              <a className="underline" href={voucherPath(item.voucherId)}>
                                {item.voucherNumber}
                              </a>
                              <div className="text-muted-foreground">
                                {item.date} · entry #{item.entryId}
                              </div>
                            </td>
                            <td className="p-2 text-right tabular-nums">
                              {item.amount} {item.currency}
                            </td>
                            <td className="p-2">
                              {!item.currencyVerified
                                ? "FX unverified"
                                : item.matched
                                  ? "Matched"
                                  : item.eligible
                                    ? "Uncleared"
                                    : "Other currency"}
                            </td>
                            <td className="p-2">
                              <Button
                                size="sm"
                                variant={selectedEntry === item.entryId ? "default" : "outline"}
                                disabled={
                                  !item.eligible ||
                                  !selected ||
                                  !exact(item.amount, selected.amount) ||
                                  item.currency !== detail.data.statement.currency
                                }
                                onClick={() => setSelectedEntry(item.entryId)}
                              >
                                Select
                              </Button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <Label>Matching note (optional)</Label>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                <Button
                  className="w-full"
                  disabled={!matchesValid || matchMutation.isPending}
                  onClick={() => matchMutation.mutate()}
                >
                  {matchMutation.isPending ? "Matching…" : "Match selected statement and voucher"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Bank fees and transfers absent from the books remain unmatched until properly posted through the
                  existing voucher workflow. No duplicate or automatic balancing vouchers will be created.
                </p>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
