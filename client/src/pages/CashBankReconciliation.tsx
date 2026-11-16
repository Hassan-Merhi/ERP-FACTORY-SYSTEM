import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { exact, fmt } from "./CashBankReconciliationTypes";
import { CashBankReconciliationSection, useCashBankReconciliationState } from "./useCashBankReconciliationState";
import { CashBankReconciliationCardSection } from "./CashBankReconciliationCardSection";

export default function CashBankReconciliation() {
  const {
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
  } = useCashBankReconciliationState();

  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="cash-bank-reconciliation">
      <PageHeader
        title="Cash & Bank Reconciliation"
        subtitle="ERP · Factory · Rentals — one accounting ledger, imported statement evidence and audited matches."
      >
        <a className="rounded-md border px-3 py-2 text-sm" href={createPath}>
          Create voucher for an unrecorded bank fee or transfer
        </a>
      </PageHeader>
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
        <CashBankReconciliationCardSection
          busy={busy}
          file={file}
          form={form}
          importMutation={importMutation}
          preview={preview}
          previewMutation={previewMutation}
          setFile={setFile}
          setForm={setForm}
          setPreview={setPreview}
        />
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
                <CashBankReconciliationSection
                  reviewCategory={reviewCategory}
                  reviewMutation={reviewMutation}
                  reviewNote={reviewNote}
                  selectedLine={selectedLine}
                  setReviewCategory={setReviewCategory}
                  setReviewNote={setReviewNote}
                />
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
