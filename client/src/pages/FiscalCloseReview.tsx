import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import type { ReviewKind } from "./FiscalCloseReviewTypes";
import { FiscalCloseReviewCardSection, useFiscalCloseReviewState } from "./useFiscalCloseReviewState";
import { FiscalCloseReviewCardSection2, FiscalCloseReviewCardSection3 } from "./FiscalCloseReviewCardSection2";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

// Phase 15 never authorizes new GL posting; certification is separate.
const UNIFIED_FINANCIAL_POSTING_CERTIFIED = false;

export default function FiscalCloseReview() {
  const {
    accounts,
    archiveReason,
    audit,
    canQuery,
    changePolicy,
    closeMutation,
    closeNote,
    confirmText,
    data,
    end,
    hasCurrent,
    history,
    note,
    policy,
    policyConfirm,
    policyReason,
    readiness,
    retainedId,
    reviewKind,
    revoke,
    selectedCompany,
    setArchiveReason,
    setCloseNote,
    setConfirmText,
    setEnd,
    setNote,
    setPolicyConfirm,
    setPolicyReason,
    setRetainedId,
    setReviewKind,
    setStart,
    setTab,
    signoff,
    start,
    tab,
    yes,
  } = useFiscalCloseReviewState();
  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="fiscal-close-review">
      <PageHeader
        title="Fiscal Period Closing & Audit Review"
        meta={selectedCompany?.name ?? "Current company"}
        subtitle="Readiness, dual approval, financial audit controls and reviewed close. This screen does not edit old vouchers."
      >
        {tab === "history" && history.data && (
          <RowsExportMenu
            title="Reviewed Fiscal Closes"
            rows={history.data.reviewedClosures}
            columns={[
              { header: "Recorded", value: (item) => item.certified_at },
              { header: "Closure", value: (item) => `Closure #${item.fiscal_closure_id ?? "reopened"}` },
              { header: "Voucher", value: (item) => `Voucher #${item.closing_voucher_id}` },
              { header: "Accounting reviewer", value: (item) => item.accounting_reviewer },
              { header: "Owner reviewer", value: (item) => item.owner_reviewer },
              { header: "Status", value: (item) => (item.currently_closed ? "Closed" : "Reopened / no longer active") },
            ]}
            resource="erp.accounts"
            data-testid="button-export-fiscal-review"
          />
        )}
        {tab === "audit" && audit.data && (
          <RowsExportMenu
            title="Fiscal Close Audit Trail"
            rows={audit.data.events}
            columns={[
              { header: "Timestamp", value: (e) => e.recorded_at },
              { header: "Action", value: (e) => e.action },
              { header: "Source", value: (e) => e.table_name },
              { header: "Actor", value: (e) => e.username },
              { header: "Reference", value: (e) => e.record_identifier },
            ]}
            resource="erp.accounts"
            data-testid="button-export-fiscal-review"
          />
        )}
      </PageHeader>
      <FiscalCloseReviewCardSection2
        changePolicy={changePolicy}
        policy={policy}
        policyConfirm={policyConfirm}
        policyReason={policyReason}
        setPolicyConfirm={setPolicyConfirm}
        setPolicyReason={setPolicyReason}
      />
      <FiscalCloseReviewCardSection
        accounts={accounts}
        canQuery={canQuery}
        data={data}
        end={end}
        readiness={readiness}
        retainedId={retainedId}
        setConfirmText={setConfirmText}
        setEnd={setEnd}
        setRetainedId={setRetainedId}
        setStart={setStart}
        start={start}
      />
      <div className="flex gap-2 flex-wrap">
        {(["readiness", "signoffs", "history", "audit"] as const).map((k) => (
          <Button key={k} size="sm" variant={tab === k ? "default" : "outline"} onClick={() => setTab(k)}>
            {
              (
                {
                  readiness: "Close readiness",
                  signoffs: "Independent signoffs",
                  history: "Reviewed closures",
                  audit: "Audit events",
                } as const
              )[k]
            }
          </Button>
        ))}
      </div>
      {!canQuery && (
        <p className="text-sm text-muted-foreground">
          Enter both period dates and an existing Retained Earnings account ID to preview readiness.
        </p>
      )}
      {readiness.isFetching && (
        <p className="text-sm text-muted-foreground">Reading posted voucher and account evidence…</p>
      )}
      {readiness.isError && (
        <p className="text-sm text-destructive" role="alert">
          {(readiness.error as Error).message}
        </p>
      )}
      {data && tab === "readiness" && (
        <Card>
          <CardHeader>
            <CardTitle>Read-only financial close checklist</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm font-semibold">
              {data.blockers.length === 0
                ? "Source-readiness checks passed — independent signoffs still required"
                : data.blockers.length + " blocking issue(s); review cannot be approved yet"}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(
                [
                  ["Posted vouchers", data.source.postedVouchers],
                  ["Posted source lines", data.source.postedVoucherLines],
                  ["Trial balance difference (USD)", data.trialBalance.differenceUsd],
                  ["Opening imbalance (USD)", data.trialBalance.openingDifferenceUsd],
                  ["Source voucher imbalance", data.source.balancedVoucherErrors],
                  ["Missing cross-company account target", data.source.missingLedgerTargets],
                  ["Untranslated FX lines", data.source.nonUsdUntranslatedLines],
                  ["P&L historical-base mismatch", data.source.pnlBaseAmountMismatchLines],
                  ["Creator identity unavailable", data.source.postingsWithoutActor],
                ] as Array<[string, string | number]>
              ).map(([k, v]) => (
                <div key={k}>
                  <p className="text-xs text-muted-foreground">{k}</p>
                  <p className="font-semibold tabular-nums">{v}</p>
                </div>
              ))}
            </div>
            <div className="grid sm:grid-cols-2 gap-2 text-sm">
              <div>Voucher-date lock: {yes(data.protections.voucherDateGuardInstalled)}</div>
              <div>Voucher-line date lock: {yes(data.protections.entryDateGuardInstalled)}</div>
              <div>All 10 table-bound audit triggers: {yes(data.protections.auditChainInstalled)}</div>
              <div>All 7 master opening-balance locks: {yes(data.protections.openingBalanceGuardInstalled)}</div>
              <div>Fiscal review metadata FORCE RLS: {yes(data.protections.reviewMetadataCompanyRlsInstalled)}</div>
            </div>
            {data.blockers.map((x, i) => (
              <p key={i} className="text-sm text-destructive">
                <strong>Blocker:</strong> {x}
              </p>
            ))}
            {data.warnings.map((x, i) => (
              <p key={i} className="text-sm text-muted-foreground">
                <strong>Review:</strong> {x}
              </p>
            ))}
            <div className="text-xs text-muted-foreground break-all">Evidence fingerprint: {data.evidenceHash}</div>
            <p className="text-sm font-medium">
              This checklist measures posted-source readiness; it does not certify the historical economic completeness
              of Factory costs, intercompany elimination, rental balances or foreign exchange.
            </p>
          </CardContent>
        </Card>
      )}
      {data && tab === "signoffs" && (
        <Card>
          <CardHeader>
            <CardTitle>Separate Accounting and Owner authorization</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm">
              Accounting reviewers must use an Admin or Developer account. Final ownership review must be signed by a
              different user with the Owner role. Changing the posted evidence invalidates the prior fingerprint. A
              valid signoff is not itself a closing journal.
            </p>
            <div className="grid sm:grid-cols-3 gap-3">
              <div>
                <Label>Review capacity</Label>
                <Select value={reviewKind} onValueChange={(value) => setReviewKind(value as ReviewKind)}>
                  <SelectTrigger className="h-10 w-full" aria-label="Review capacity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACCOUNTING">Accounting review (Admin/Developer)</SelectItem>
                    <SelectItem value="OWNER">Owner approval (Owner)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-2">
                <Label>Review evidence / explanation</Label>
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Describe reviewed balances and outstanding cautions"
                />
              </div>
            </div>
            <Button
              disabled={
                !data.eligibleForSignoff ||
                note.trim().length < 10 ||
                signoff.isPending ||
                hasCurrent.some((s) => s.kind === reviewKind)
              }
              onClick={() => signoff.mutate()}
            >
              Sign current source fingerprint
            </Button>
            {data.signoffs.map((item) => (
              <div key={item.id} className="border-b pb-3 space-y-1">
                <div className="text-sm font-medium">
                  {item.kind} · {item.reviewerName} ({item.reviewedAt})
                </div>
                <div className="text-xs text-muted-foreground">
                  {item.current ? "Valid for current source hash" : "Revoked or superseded by changed source evidence"}
                </div>
                <p className="text-sm">{item.note}</p>
                {item.current && (
                  <div className="flex gap-2 flex-wrap items-center">
                    <Input
                      className="max-w-xs"
                      value={archiveReason}
                      onChange={(e) => setArchiveReason(e.target.value)}
                      placeholder="Reason to revoke signed review (Owner only)"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={archiveReason.trim().length < 10 || revoke.isPending}
                      onClick={() => revoke.mutate(item.id)}
                    >
                      Revoke signoff
                    </Button>
                  </div>
                )}
              </div>
            ))}
            <div className="border-t pt-4 space-y-3">
              <p className="font-semibold">Owner-confirmed reviewed fiscal close</p>
              <p className="text-sm text-muted-foreground">
                This is a real posting action, not a preview. It invokes the existing fiscal-period closing engine in
                the same transaction as its review evidence. It requires all readiness checks and two distinct current
                signoffs.
              </p>
              <div>
                <Label>Optional closing journal note</Label>
                <Input
                  value={closeNote}
                  onChange={(e) => setCloseNote(e.target.value)}
                  placeholder="Financial closing reference"
                />
              </div>
              <div>
                <Label>Type CLOSE {data.periodEndDate} to confirm</Label>
                <Input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={"CLOSE " + data.periodEndDate}
                />
              </div>
              <p className="text-sm text-destructive">
                Phase 15 safety lock: this new reviewed fiscal journal-posting path remains disabled until independent
                Claude and finance certification. Readiness and approvals alone do not unlock voucher posting.
              </p>
              <Button
                disabled={
                  !UNIFIED_FINANCIAL_POSTING_CERTIFIED ||
                  !data.reviewedCloseReady ||
                  confirmText !== "CLOSE " + data.periodEndDate ||
                  closeMutation.isPending
                }
                onClick={() => closeMutation.mutate()}
              >
                Reviewed closing locked — pending certification
              </Button>
              <p className="text-xs text-muted-foreground">
                This reviewed path does not reopen closed periods and does not replace the separately authorized legacy
                fiscal close/reopen screens.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {tab === "history" && <FiscalCloseReviewCardSection3 history={history} />}
      {tab === "audit" && (
        <Card>
          <CardHeader>
            <CardTitle>Fiscal approval and close audit trail</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Shows stored approval/close/reopen audit events for this company only (latest 250).
            </p>
            {audit.isError && (
              <p role="alert" className="text-sm text-destructive">
                {(audit.error as Error).message}
              </p>
            )}
            <div className="max-h-[540px] overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2">Timestamp</th>
                    <th className="p-2">Action</th>
                    <th className="p-2">Source</th>
                    <th className="p-2">Actor</th>
                    <th className="p-2">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data?.events.map((e) => (
                    <tr key={e.id} className="border-b">
                      <td className="p-2">{e.recorded_at}</td>
                      <td className="p-2">{e.action}</td>
                      <td className="p-2">{e.table_name}</td>
                      <td className="p-2">{e.username}</td>
                      <td className="p-2">{e.record_identifier ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
