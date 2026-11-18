import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu, type RowsExportSheet } from "@/components/export/RowsExportMenu";
import {
  UnifiedRentalAccountingCardSection,
  UnifiedRentalAccountingSection,
  name,
  useUnifiedRentalAccountingState,
  type Expense,
  type Guarantee,
  type Payment,
} from "./useUnifiedRentalAccountingState";

export default function UnifiedRentalAccounting() {
  const {
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
  } = useUnifiedRentalAccountingState();
  return (
    <div className="p-3 sm:p-5 space-y-5" data-testid="unified-rental-accounting">
      <PageHeader
        title="Unified Rental Accounting"
        subtitle="Tenant-side shops and shared leases show rent payable; landlord-side warehouses show rent receivable. Contract-month ledger, payments, advance rent, deposits and property expenses. Financial vouchers remain unchanged."
      >
        {detail.data && (
          <RowsExportMenu
            title="Rental Accounting"
            period={{ to: asOf }}
            filters={[
              {
                label: "Contract",
                value: `${detail.data.contract.unitNumber} · ${detail.data.contract.tenantName} · ${detail.data.contract.currency}`,
              },
            ]}
            sheetName="Contract months"
            rows={detail.data.periods}
            columns={[
              { header: "Due", value: (p) => p.dueDate },
              { header: "Expected", value: (p) => p.expected, type: "number" },
              { header: "Paid", value: (p) => p.paid, type: "number" },
              { header: "Outstanding", value: (p) => p.outstanding, type: "number" },
              {
                header: "Accrual evidence",
                value: (p) =>
                  (p.accrualVoucherId
                    ? `Voucher #${p.accrualVoucherId}`
                    : p.accrualStale
                      ? "Stale accrual link"
                      : "Not accrued") +
                  (p.usedPrepaidAccount || p.usedAdvanceAccount ? " · Advance/prepaid recognition" : ""),
              },
              { header: "Status", value: (p) => p.status },
            ]}
            extraSheets={[
              ...(showPayments
                ? [
                    {
                      name: "Payment allocations",
                      rows: detail.data.payments,
                      columns: [
                        { header: "Paid / planned date", value: (p) => p.date },
                        {
                          header: "Period",
                          value: (p) => p.period + (p.isGuaranteeActivity ? " · Deposit activity, not rent" : ""),
                        },
                        { header: "Amount", value: (p) => p.amount, type: "number" },
                        { header: "Currency", value: (p) => p.currency },
                        { header: "Recorded FX", value: (p) => p.historicalRate },
                        { header: "Posting", value: (p) => p.status },
                        {
                          header: "Voucher",
                          value: (p) => (p.voucherId ? p.voucherNumber || "#" + p.voucherId : null),
                        },
                      ],
                    } satisfies RowsExportSheet<Payment>,
                  ]
                : []),
              {
                name: "Deposit evidence",
                rows: detail.data.guarantee.vouchers,
                columns: [
                  { header: "Date", value: (g) => g.date },
                  { header: "Voucher", value: (g) => g.voucherNumber },
                  { header: "Account", value: (g) => g.accountCode },
                  { header: "USD", value: (g) => g.signedUsd, type: "number" },
                ],
              } satisfies RowsExportSheet<Guarantee["vouchers"][number]>,
              {
                name: "Property expenses",
                rows: detail.data.expenses,
                columns: [
                  { header: "Category", value: (e) => name(e.category) },
                  { header: "Voucher", value: (e) => e.voucherNumber || "#" + e.voucherId },
                  { header: "USD", value: (e) => e.amountUsd, type: "number" },
                  {
                    header: "Source",
                    value: (e) =>
                      e.sourceStatus !== "active"
                        ? `Source voucher ${e.sourceStatus} — excluded from current expense total`
                        : null,
                  },
                  { header: "Note", value: (e) => e.note },
                ],
              } satisfies RowsExportSheet<Expense>,
            ]}
            resource="erp.accounts"
            data-testid="button-export-rental-accounting"
          />
        )}
      </PageHeader>
      <UnifiedRentalAccountingCardSection
        asOf={asOf}
        detail={detail}
        id={id}
        list={list}
        setAsOf={setAsOf}
        setId={setId}
      />
      {detail.isError && (
        <p role="alert" className="text-destructive text-sm">
          {(detail.error as Error).message}
        </p>
      )}
      {detail.data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                {detail.data.contract.locationGroup}/{detail.data.contract.unitNumber} ·{" "}
                {detail.data.contract.tenantName} (
                {detail.data.perspective === "TENANT" ? "Tenant payable" : "Landlord receivable"})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {(
                  [
                    ["Due rent (native)", totals!.expectedDue],
                    ["Posted rent applied (native)", totals!.postedAgainstDue],
                    [detail.data.perspective === "LANDLORD" ? "Rent receivable" : "Rent payable", totals!.outstanding],
                    ["Advance / overpaid rent (native)", totals!.advanceFuturePeriods],
                    ["Scheduled, not posted (native)", totals!.scheduledNotPosted],
                    ["Property expenses allocated (USD)", totals!.maintenanceExpensesBaseUsd],
                    ["Contract deposit pledge (native)", totals!.depositPledgeNative],
                    ["Deposit book evidence (USD)", totals!.depositBalanceEvidenceUsd],
                  ] as Array<[string, string]>
                ).map(([label, v]) => (
                  <div key={label}>
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="font-semibold text-lg tabular-nums">{v}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Contract currency: {detail.data.contract.currency} · Monthly rent: {detail.data.contract.monthlyRent} ·
                Contract: {detail.data.contract.startDate} to {detail.data.contract.endDate ?? "ongoing"} · As-of:{" "}
                {detail.data.asOfDate}
              </p>
              {detail.data.warnings.map((w, i) => (
                <p role="alert" key={i} className="text-sm text-destructive">
                  {w}
                </p>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Monthly rent / accrual / arrears</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="max-h-[490px] overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="p-2">Due</th>
                      <th className="p-2 text-right">Expected</th>
                      <th className="p-2 text-right">Paid</th>
                      <th className="p-2 text-right">Outstanding</th>
                      <th className="p-2">Accrual evidence</th>
                      <th className="p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.periods.map((p) => (
                      <tr key={p.year + "-" + p.month} className="border-b align-top">
                        <td className="p-2">{p.dueDate}</td>
                        <td className="p-2 text-right tabular-nums">{p.expected}</td>
                        <td className="p-2 text-right tabular-nums">{p.paid}</td>
                        <td className="p-2 text-right tabular-nums">{p.outstanding}</td>
                        <td className="p-2">
                          {p.accrualVoucherId ? (
                            <a className="underline" href={voucherLink(p.accrualVoucherId)}>
                              Voucher #{p.accrualVoucherId}
                            </a>
                          ) : p.accrualStale ? (
                            "Stale accrual link"
                          ) : (
                            "Not accrued"
                          )}
                          {(p.usedPrepaidAccount || p.usedAdvanceAccount) && (
                            <div className="text-xs text-muted-foreground">Advance/prepaid recognition</div>
                          )}
                        </td>
                        <td className="p-2">
                          {p.status}
                          {p.cacheDifference !== null && p.cacheDifference !== "0.00" && (
                            <div className="text-xs text-destructive">Cached paid differs by {p.cacheDifference}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!detail.data.periods.length && (
                  <p className="p-3 text-sm text-muted-foreground">No contractual month is due yet.</p>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Posted / scheduled payment allocations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button variant="outline" size="sm" onClick={() => setShowPayments((x) => !x)}>
                {showPayments ? "Hide payment details" : "View payments and historical rates"}
              </Button>
              {showPayments && (
                <div className="max-h-[430px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Paid / planned date</th>
                        <th className="p-2">Period</th>
                        <th className="p-2">Amount</th>
                        <th className="p-2">Recorded FX</th>
                        <th className="p-2">Posting</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.payments.map((p) => (
                        <tr key={p.id} className="border-b">
                          <td className="p-2">{p.date}</td>
                          <td className="p-2">
                            {p.period}
                            {p.isGuaranteeActivity && <div className="text-xs">Deposit activity, not rent</div>}
                          </td>
                          <td className="p-2">
                            {p.amount} {p.currency}
                          </td>
                          <td className="p-2">{p.historicalRate}</td>
                          <td className="p-2">
                            {p.status}
                            {p.voucherId && (
                              <div>
                                <a className="underline" href={voucherLink(p.voucherId)}>
                                  {p.voucherNumber || "#" + p.voucherId}
                                </a>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Guarantee / security deposit evidence</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Pledged deposit in contract currency:
                {" " + detail.data.guarantee.contractPledgeNative} {detail.data.contract.currency}. Posted deposit
                asset/liability movements are shown in booked USD, without converting the original pledge at today's
                rate.
              </p>
              <p className="text-sm">
                Deposit statement flag: {detail.data.guarantee.statementFlag ? "yes" : "no"} · Book evidence:{" "}
                {detail.data.guarantee.ledgerEvidenceUsd} USD
              </p>
              <div className="max-h-[230px] overflow-auto">
                {detail.data.guarantee.vouchers.map((g, i) => (
                  <div key={g.voucherId + ":" + i} className="border-b py-2 flex flex-wrap gap-x-3 text-sm">
                    <span>{g.date}</span>
                    <a className="underline" href={voucherLink(g.voucherId)}>
                      {g.voucherNumber}
                    </a>
                    <span>{g.accountCode}</span>
                    <span className="tabular-nums">{g.signedUsd} USD</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Maintenance / property expense attribution</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Select an existing posted expense voucher and attribute only its expense debit to this rental contract.
                Several units may share one voucher, but total allocations cannot exceed its booked USD expense. This
                creates no new expense, bill, cash movement, or voucher.
              </p>
              <UnifiedRentalAccountingSection
                amount={amount}
                category={category}
                note={note}
                setAmount={setAmount}
                setCategory={setCategory}
                setNote={setNote}
                setRequestId={setRequestId}
                setVoucher={setVoucher}
                voucher={voucher}
              />
              <Button
                disabled={
                  !Number.isSafeInteger(Number(voucher)) ||
                  Number(voucher) < 1 ||
                  !amount.trim() ||
                  post.isPending ||
                  !!asOf
                }
                onClick={() => post.mutate()}
              >
                Attribute existing expense
              </Button>
              {asOf && (
                <p className="text-xs text-muted-foreground">
                  Historical as-of views are read-only. Clear the as-of date to attribute expenses.
                </p>
              )}
              <div className="max-h-[360px] overflow-auto">
                {detail.data.expenses.map((e) => (
                  <div key={e.id} className="border-b py-2 flex flex-wrap items-center gap-3 text-sm">
                    <span>{name(e.category)}</span>
                    <a href={voucherLink(e.voucherId)} className="underline">
                      {e.voucherNumber || "#" + e.voucherId}
                    </a>
                    <span className="tabular-nums">{e.amountUsd} USD</span>
                    {e.sourceStatus !== "active" && (
                      <span className="text-destructive text-xs">
                        Source voucher {e.sourceStatus} — excluded from current expense total
                      </span>
                    )}
                    {e.note && <span className="text-muted-foreground">{e.note}</span>}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!voidReason.trim() || voidLink.isPending || !!asOf}
                      onClick={() => voidLink.mutate(e.id)}
                    >
                      Remove link
                    </Button>
                  </div>
                ))}
              </div>
              <div>
                <Label>Required reason for removing a linked allocation</Label>
                <Input
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="Explain the correction"
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Accounting treatment and limitations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              {Object.values(detail.data.limitations).map((v, i) => (
                <p key={i}>{v}</p>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
