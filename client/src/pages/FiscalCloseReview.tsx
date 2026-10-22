/**
 * Phase 13 — Fiscal Close Readiness / Independent Financial Review.
 * GET reads never post. Reviewed close is a separate explicit Owner action;
 * existing fiscal period close/reopen workflows are not silently invoked.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

// Phase 15 never authorizes new GL posting; certification is separate.
const UNIFIED_FINANCIAL_POSTING_CERTIFIED = false;
type ReviewKind = "ACCOUNTING" | "OWNER";
interface Readiness {
  companyId: number;
  periodStartDate: string;
  periodEndDate: string;
  retainedEarningsAccountId: number;
  businessDate: string;
  evidenceHash: string;
  reviewedCloseReady: boolean;
  eligibleForSignoff: boolean;
  trialBalance: {
    balanced: boolean;
    differenceUsd: string;
    openingDifferenceUsd: string;
    singleSidedStockDifferenceUsd: string;
    otherDifferenceUsd: string;
    assumedOpeningSides: number;
  };
  source: {
    postedVouchers: number;
    postedVoucherLines: number;
    sourceDigest: string;
    balancedVoucherErrors: number;
    missingLedgerTargets: number;
    nonUsdUntranslatedLines: number;
    pnlBaseAmountMismatchLines: number;
    optionalVouchers: number;
    postingsWithoutActor: number;
  };
  history: {
    latestClosedEnd: string | null;
    expectedNextStart: string | null;
    closedPeriods: Array<{ id: number; from: string; to: string; voucherId: number; netIncomeUsd: string }>;
  };
  protections: {
    voucherDateGuardInstalled: boolean;
    entryDateGuardInstalled: boolean;
    auditChainInstalled: boolean;
    openingBalanceGuardInstalled: boolean;
    reviewMetadataCompanyRlsInstalled: boolean;
  };
  signoffs: Array<{
    id: number;
    kind: ReviewKind;
    reviewerId: string;
    reviewerName: string;
    reviewedAt: string;
    note: string;
    current: boolean;
  }>;
  blockers: string[];
  warnings: string[];
  certified: false;
}
interface EquityAccounts {
  companyId: number;
  accounts: Array<{ id: number; code: string; name: string }>;
  limit: number;
}
interface ReviewPolicy {
  companyId: number;
  enforceReviewedClose: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  reason: string | null;
  explicitlyConfigured: boolean;
}
interface CloseHistory {
  reviewedClosures: Array<{
    id: number;
    fiscal_closure_id: number | null;
    closing_voucher_id: number;
    evidence_hash: string;
    certified_at: string;
    reviewed_by: string;
    accounting_reviewer: string;
    owner_reviewer: string;
    currently_closed: boolean;
  }>;
}
interface AuditHistory {
  events: Array<{
    id: number;
    action: string;
    table_name: string;
    record_identifier: string | null;
    user_id: string;
    username: string;
    recorded_at: string;
    changes: unknown;
  }>;
}
const root = "/api/accounting/fiscal-review";
async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? "Fiscal review unavailable");
  return body as T;
}
const isoNow = () => new Date().toISOString().slice(0, 10);
const defaultStart = () => isoNow().slice(0, 4) + "-01-01";
export default function FiscalCloseReview() {
  const { selectedCompany } = useCompany(),
    companyId = selectedCompany?.id;
  const { toast } = useToast(),
    client = useQueryClient();
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState("");
  const [retainedId, setRetainedId] = useState("");
  const [reviewKind, setReviewKind] = useState<ReviewKind>("ACCOUNTING");
  const [note, setNote] = useState("");
  const [archiveReason, setArchiveReason] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [tab, setTab] = useState<"readiness" | "signoffs" | "history" | "audit">("readiness");
  const [policyReason, setPolicyReason] = useState("");
  const [policyConfirm, setPolicyConfirm] = useState("");
  const params = new URLSearchParams({
    periodStartDate: start,
    periodEndDate: end,
    retainedEarningsAccountId: retainedId,
  });
  const canQuery = !!companyId && !!start && !!end && Number(retainedId) > 0;
  const accounts = useQuery<EquityAccounts>({
    queryKey: [root + "/equity-accounts", companyId],
    queryFn: () => read(root + "/equity-accounts"),
    enabled: !!companyId,
    retry: false,
  });
  const policy = useQuery<ReviewPolicy>({
    queryKey: [root + "/policy", companyId],
    queryFn: () => read(root + "/policy"),
    enabled: !!companyId,
    retry: false,
  });
  const readiness = useQuery<Readiness>({
    queryKey: [root + "/readiness", companyId, start, end, retainedId],
    queryFn: () => read(root + "/readiness?" + params.toString()),
    enabled: canQuery,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const history = useQuery<CloseHistory>({
    queryKey: [root + "/history", companyId],
    queryFn: () => read(root + "/history"),
    enabled: !!companyId && tab === "history",
    retry: false,
  });
  const audit = useQuery<AuditHistory>({
    queryKey: [root + "/audit", companyId],
    queryFn: () => read(root + "/audit"),
    enabled: !!companyId && tab === "audit",
    retry: false,
  });
  const data = readiness.data;
  const hasCurrent = useMemo(() => data?.signoffs.filter((x) => x.current) ?? [], [data]);
  const reviewHash = data?.evidenceHash ?? "";
  const onError = (error: Error) =>
    toast({ title: "Fiscal review refused", description: error.message, variant: "destructive" });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: [root + "/readiness"] }),
      client.invalidateQueries({ queryKey: [root + "/history"] }),
      client.invalidateQueries({ queryKey: [root + "/audit"] }),
      client.invalidateQueries({ queryKey: [root + "/policy"] }),
    ]);
  };
  const changePolicy = useMutation({
    mutationFn: async (enforce: boolean) => {
      const response = await apiRequest("POST", root + "/policy", {
        enforce,
        reason: policyReason,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({ title: "Fiscal review requirement updated and audited" });
      setPolicyReason("");
      setPolicyConfirm("");
      await refresh();
    },
    onError,
  });
  const signoff = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", root + "/signoffs", {
        periodStartDate: start,
        periodEndDate: end,
        retainedEarningsAccountId: Number(retainedId),
        evidenceHash: reviewHash,
        reviewKind,
        note,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({ title: "Independent review recorded" });
      setNote("");
      await refresh();
    },
    onError,
  });
  const revoke = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest("POST", root + "/signoffs/" + id + "/revoke", {
        reason: archiveReason,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({ title: "Review revoked with audit reason" });
      setArchiveReason("");
      await refresh();
    },
    onError,
  });
  const closeMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", root + "/close", {
        periodStartDate: start,
        periodEndDate: end,
        retainedEarningsAccountId: Number(retainedId),
        evidenceHash: reviewHash,
        notes: closeNote || undefined,
      });
      return response.json();
    },
    onSuccess: async (result: { closingVoucherId: number }) => {
      toast({
        title: "Reviewed fiscal close posted",
        description: "Original fiscal-close engine posted voucher #" + result.closingVoucherId,
      });
      setConfirmText("");
      setCloseNote("");
      await refresh();
    },
    onError,
  });
  const yes = (x: boolean) => (x ? "Installed" : "Missing / disabled");
  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="fiscal-close-review">
      <div>
        <h1 className="text-2xl font-semibold">Fiscal Period Closing & Audit Review</h1>
        <p className="text-sm text-muted-foreground">
          {selectedCompany?.name ?? "Current company"} · Readiness, dual approval, financial audit controls and reviewed
          close. This screen does not edit old vouchers.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Reviewed-close enforcement (Owner only)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {policy.isError && <p className="text-destructive text-sm">{(policy.error as Error).message}</p>}
          {policy.data && (
            <>
              <p className="font-medium text-sm">
                {policy.data.enforceReviewedClose
                  ? "Required: every new close must use the dual-reviewed path"
                  : "Compatibility mode: the original close endpoint is still permitted"}
              </p>
              <p className="text-xs text-muted-foreground">
                Defaults to compatibility mode for existing companies. A signed Owner change is audited. Reopening
                remains a separate, reason-required Admin action.
              </p>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <Label>Owner reason for policy change</Label>
                  <Input
                    value={policyReason}
                    onChange={(e) => setPolicyReason(e.target.value)}
                    placeholder="Explain why the fiscal-close requirement changes"
                  />
                </div>
                <div>
                  <Label>Type POLICY CHANGE to confirm</Label>
                  <Input
                    value={policyConfirm}
                    onChange={(e) => setPolicyConfirm(e.target.value)}
                    placeholder="POLICY CHANGE"
                  />
                </div>
              </div>
              <Button
                variant="outline"
                disabled={
                  policyReason.trim().length < 10 || policyConfirm !== "POLICY CHANGE" || changePolicy.isPending
                }
                onClick={() => changePolicy.mutate(!policy.data!.enforceReviewedClose)}
              >
                {policy.data.enforceReviewedClose
                  ? "Disable mandatory reviewed-close (Owner)"
                  : "Require independent reviewed-close (Owner)"}
              </Button>
              {policy.data.updatedAt && (
                <p className="text-xs text-muted-foreground">
                  Last change: {policy.data.updatedAt} · {policy.data.reason}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Period and retained earnings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>Period begins</Label>
              <Input
                type="date"
                value={start}
                onChange={(v) => {
                  setStart(v.target.value);
                  setConfirmText("");
                }}
              />
            </div>
            <div>
              <Label>Period ends</Label>
              <Input
                type="date"
                value={end}
                onChange={(v) => {
                  setEnd(v.target.value);
                  setConfirmText("");
                }}
              />
            </div>
            <div>
              <Label>Existing Retained Earnings / Equity account</Label>
              <select
                className="h-10 w-full rounded-md border bg-background px-2"
                value={retainedId}
                onChange={(e) => {
                  setRetainedId(e.target.value);
                  setConfirmText("");
                }}
              >
                <option value="">Select an active Equity account</option>
                {accounts.data?.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name} (#{a.id})
                  </option>
                ))}
              </select>
              {accounts.isError && <p className="text-xs text-destructive">Unable to list existing Equity accounts</p>}
            </div>
          </div>
          {data?.history.latestClosedEnd && (
            <p className="text-sm text-muted-foreground">
              Latest closed period ends {data.history.latestClosedEnd}. Next period must begin{" "}
              {data.history.expectedNextStart}.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Only an existing active Equity account from this company is accepted. No account is created automatically.
            For date periods that are still open, review only; a close cannot include today.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={!canQuery || readiness.isFetching} onClick={() => readiness.refetch()}>
              Refresh financial evidence
            </Button>
            <span className="text-xs text-muted-foreground">
              Every refresh recalculates the evidence fingerprint from the current posted ledger.
            </span>
          </div>
        </CardContent>
      </Card>
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
                <select
                  className="h-10 w-full rounded-md border bg-background px-2"
                  value={reviewKind}
                  onChange={(e) => setReviewKind(e.target.value as ReviewKind)}
                >
                  <option value="ACCOUNTING">Accounting review (Admin/Developer)</option>
                  <option value="OWNER">Owner approval (Owner)</option>
                </select>
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
      {tab === "history" && (
        <Card>
          <CardHeader>
            <CardTitle>Recorded reviewed fiscal closes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {history.isError && (
              <p role="alert" className="text-sm text-destructive">
                {(history.error as Error).message}
              </p>
            )}
            <div className="max-h-[540px] overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2">Recorded</th>
                    <th className="p-2">Closure / voucher</th>
                    <th className="p-2">Accounting reviewer</th>
                    <th className="p-2">Owner reviewer</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data?.reviewedClosures.map((item) => (
                    <tr key={item.id} className="border-b">
                      <td className="p-2">{item.certified_at}</td>
                      <td className="p-2">
                        Closure #{item.fiscal_closure_id ?? "reopened"}
                        <div className="text-xs">Voucher #{item.closing_voucher_id}</div>
                      </td>
                      <td className="p-2">{item.accounting_reviewer}</td>
                      <td className="p-2">{item.owner_reviewer}</td>
                      <td className="p-2">{item.currently_closed ? "Closed" : "Reopened / no longer active"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
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
