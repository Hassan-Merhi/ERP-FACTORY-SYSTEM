import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { UnifiedAccountingRolloutSection, useUnifiedAccountingRolloutState } from "./useUnifiedAccountingRolloutState";
import { UnifiedAccountingRolloutCardSection } from "./UnifiedAccountingRolloutCardSection";

export default function UnifiedAccountingRollout() {
  const {
    addReview,
    changeMode,
    confirmation,
    d,
    evidenceReference,
    go,
    hasReview,
    launchReady,
    pageForPhase,
    policyReason,
    readiness,
    refresh,
    reviewKind,
    reviewNotes,
    revoke,
    revokeReason,
    selectedCompany,
    selectedMode,
    selectedPolicy,
    setConfirmation,
    setEvidenceReference,
    setPolicyReason,
    setReviewKind,
    setReviewNotes,
    setRevokeReason,
    setTab,
    tab,
  } = useUnifiedAccountingRolloutState();
  return (
    <div className="p-3 sm:p-5 space-y-5" data-testid="unified-accounting-rollout">
      <PageHeader
        title="Unified Accounting — Integration & Rollout"
        meta={<>{selectedCompany?.name ?? "Selected company"} · Phase 15</>}
        subtitle="Company-specific read-only certification and Owner-governed metadata pilot"
      />
      <Card>
        <CardContent className="pt-5 space-y-3">
          <div className="flex flex-wrap gap-3 items-center justify-between">
            <p className="font-semibold">
              Release mode:{" "}
              {selectedMode === "READ_ONLY"
                ? "Read-only (new financial writers locked)"
                : d?.pilotOperational
                  ? "Metadata-only pilot active"
                  : "Metadata pilot configured — writers locked"}
            </p>
            <Button variant="outline" disabled={readiness.isFetching} onClick={() => void refresh()}>
              Refresh release readiness
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {d?.pilotOperational
              ? "Current metadata write eligibility passed (not an accounting or security certification)"
              : "New unified accounting metadata writes remain locked. Stored pilot settings and review references alone do not authorize an operation."}
          </p>
          <p className="text-xs text-muted-foreground break-all">
            Deployed revision: {d?.deployedSha ?? "Not available — source signoff cannot be granted"}
          </p>
          <p className="text-xs font-medium text-destructive">
            Uncertified source implementation. Claude has not supplied verified CI, accounting reconciliation, or
            multi-company security evidence in this rollout record. Recording a reference does not validate the
            referenced work.
          </p>
        </CardContent>
      </Card>
      <div className="flex gap-2 flex-wrap">
        {(["readiness", "reviews", "release", "phases"] as const).map((k) => (
          <Button size="sm" key={k} variant={tab === k ? "default" : "outline"} onClick={() => setTab(k)}>
            {
              (
                {
                  readiness: "Safety & readiness",
                  reviews: "Review evidence",
                  release: "Owner rollout controls",
                  phases: "All 15 phases",
                } as const
              )[k]
            }
          </Button>
        ))}
      </div>
      {readiness.isFetching && (
        <p className="text-sm text-muted-foreground">
          Loading current company trial balance, policy and metadata controls…
        </p>
      )}
      {readiness.isError && (
        <p className="text-sm text-destructive" role="alert">
          {(readiness.error as Error).message}
        </p>
      )}
      {tab === "readiness" && d && (
        <Card>
          <CardHeader>
            <CardTitle>Source-level release readiness — not external certification</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Trial balance</p>
                <p className="font-semibold">{d.bookedTrial.balanced ? "Balanced" : "Unbalanced"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Unexplained USD</p>
                <p className="font-semibold">{d.bookedTrial.differenceUsd}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Missing tables</p>
                <p className="font-semibold">{d.schema.missing.length}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Unprotected / policy-less tables</p>
                <p className="font-semibold">{d.schema.unprotected.length}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Historical FX missing entries</p>
                <p className="font-semibold">{d.historicalFx.unresolvedEntryCount}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Voucher-edit / metadata FK compatibility</p>
                <p className="font-semibold">
                  {d.metadataEntryReferencesCompatible ? "Source gate cleared — review required" : "Blocked"}
                </p>
              </div>
            </div>
            {d.blockers.length === 0 ? (
              <p className="text-sm font-medium">
                Structural checks passed. Independent CI, financial and security evidence must still be reviewed before
                Owner promotion.
              </p>
            ) : (
              <p className="text-sm text-destructive font-medium">
                {d.blockers.length} rollout blocker(s). Pilot cannot be approved.
              </p>
            )}
            {d.blockers.map((msg, i) => (
              <p role="alert" key={i} className="text-sm text-destructive">
                • {msg}
              </p>
            ))}
            {d.warnings.map((msg, i) => (
              <p key={i} className="text-sm text-muted-foreground">
                • {msg}
              </p>
            ))}
            <h3 className="font-semibold">Scoped metadata schema verification</h3>
            <div className="overflow-x-auto max-h-[420px]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="p-2">Table</th>
                    <th className="p-2">Exists</th>
                    <th className="p-2">RLS</th>
                    <th className="p-2">FORCE RLS</th>
                    <th className="p-2">Policy exists</th>
                  </tr>
                </thead>
                <tbody>
                  {d.schema.tables.map((t) => (
                    <tr key={t.name} className="border-b">
                      <td className="p-2">{t.name}</td>
                      <td className="p-2">{t.exists ? "Yes" : "Missing"}</td>
                      <td className="p-2">{t.rls ? "Yes" : "No"}</td>
                      <td className="p-2">{t.forced ? "Yes" : "No"}</td>
                      <td className="p-2">{t.hasPolicy ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-sm font-medium">
              Perpetual inventory activation: Not available through Phase 15. Global writer-ready:{" "}
              {d.posting.perpetualReady ? "True" : "False"}.
            </p>
          </CardContent>
        </Card>
      )}
      {tab === "reviews" && d && (
        <Card>
          <CardHeader>
            <CardTitle>Manual, release-pinned certification evidence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Independent technical and security reviewers must have Admin/Developer access. Finance reviewers use
              Admin/Owner access. An Owner cannot promote a pilot using their own technical signoff. Evidence references
              must point to external real verification results.
            </p>
            <UnifiedAccountingRolloutSection
              evidenceReference={evidenceReference}
              reviewKind={reviewKind}
              reviewNotes={reviewNotes}
              setEvidenceReference={setEvidenceReference}
              setReviewKind={setReviewKind}
              setReviewNotes={setReviewNotes}
            />
            <Button
              disabled={
                !d.deployedSha ||
                hasReview(reviewKind) ||
                evidenceReference.trim().length < 12 ||
                reviewNotes.trim().length < 10 ||
                addReview.isPending
              }
              onClick={() => addReview.mutate()}
            >
              Record external evidence review
            </Button>
            <div className="border-t pt-3">
              <Label>Owner reason to revoke an existing review</Label>
              <Input
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                placeholder="At least ten characters — why this evidence is withdrawn"
              />
            </div>
            {d.releaseReviews.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No reviews are recorded for the current deployed revision.
              </p>
            )}
            {d.releaseReviews.map((v) => (
              <div key={v.id} className="border-b py-3 text-sm space-y-1">
                <p className="font-semibold">
                  {v.kind} · {v.reviewerName} · {v.revoked ? "Revoked" : "Current"}
                </p>
                <p>
                  {v.reviewedAt} · {v.evidenceReference}
                </p>
                <p className="text-muted-foreground">{v.notes}</p>
                {!v.revoked && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={revokeReason.trim().length < 10 || revoke.isPending}
                    onClick={() => revoke.mutate(v.id)}
                  >
                    Owner: revoke review
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {tab === "release" && d && (
        <UnifiedAccountingRolloutCardSection
          changeMode={changeMode}
          confirmation={confirmation}
          launchReady={launchReady}
          policyReason={policyReason}
          selectedMode={selectedMode}
          selectedPolicy={selectedPolicy}
          setConfirmation={setConfirmation}
          setPolicyReason={setPolicyReason}
        />
      )}
      {tab === "phases" && d && (
        <Card>
          <CardHeader>
            <CardTitle>Unified accounting project — phases 1–15</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Every phase has source code committed to the feature branch but requires Claude's independent compilation,
              CI and accounting certification. This list does not claim passing tests.
            </p>
            {d.phaseCatalog.map((entry) => (
              <div
                key={entry.phase}
                className="flex flex-wrap gap-2 items-center justify-between border-b py-2 text-sm"
              >
                <div>
                  <span className="font-semibold">Phase {entry.phase}</span> · {entry.title}
                  <p className="text-xs text-muted-foreground">Source committed · pending verification</p>
                </div>
                {pageForPhase(entry.phase, entry.erpPath) ? (
                  <Button size="sm" variant="outline" onClick={() => go(pageForPhase(entry.phase, entry.erpPath)!)}>
                    Open page
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">Available in ERP accounting</span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
