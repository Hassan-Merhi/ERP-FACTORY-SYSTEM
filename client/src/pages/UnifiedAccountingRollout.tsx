/** Phase 15 — release evidence and Owner-governed metadata pilot. */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";

type Kind = "TECHNICAL" | "SECURITY" | "FINANCE";
type Mode = "READ_ONLY" | "METADATA_PILOT";
interface Review {
  id: number;
  kind: Kind;
  reviewerId: string;
  reviewerName: string;
  reviewedAt: string;
  evidenceReference: string;
  notes: string;
  revoked: boolean;
}
interface Policy {
  companyId: number;
  releaseMode: Mode;
  releaseSha: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  reason: string | null;
  configured: boolean;
}
interface Readiness {
  companyId: number;
  businessDate: string;
  deployedSha: string | null;
  releaseMode: Mode;
  policy: Policy;
  bookedTrial: { balanced: boolean; differenceUsd: string; assumedOpeningSides: number };
  historicalFx: {
    ready: boolean;
    unresolvedEntryCount: number;
    unresolvedVoucherCount: number;
    sampleVoucherIds: number[];
    certified: false;
    caveat: string;
  };
  schema: {
    missing: string[];
    unprotected: string[];
    tables: Array<{
      name: string;
      exists: boolean;
      rls: boolean;
      forced: boolean;
      hasPolicy: boolean;
    }>;
  };
  posting: {
    perpetualReady: boolean;
    phase15CanActivateInventory: false;
    phase15CanPostFinancialVouchers: false;
    phase15CanRewriteHistoricalVouchers: false;
  };
  phaseCatalog: Array<{ phase: number; title: string; erpPath: string; implementation: string }>;
  releaseReviews: Review[];
  reviewsComplete: boolean;
  blockers: string[];
  warnings: string[];
  eligibleForExternalReview: boolean;
  pilotOperational: boolean;
  metadataEntryReferencesCompatible: boolean;
  certified: false;
  status: "PROVISIONAL_NOT_CERTIFIED";
}
const root = "/api/accounting/rollout";
const kinds: Kind[] = ["TECHNICAL", "SECURITY", "FINANCE"];
async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message ?? "Rollout report unavailable");
  return result as T;
}
export default function UnifiedAccountingRollout() {
  const [path, go] = useLocation();
  const prefix = path.startsWith("/factory/") ? "/factory" : path.startsWith("/properties/") ? "/properties" : "";
  const { selectedCompany } = useCompany(),
    companyId = selectedCompany?.id;
  const { toast } = useToast(),
    cache = useQueryClient();
  const [tab, setTab] = useState<"readiness" | "reviews" | "release" | "phases">("readiness");
  const [reviewKind, setReviewKind] = useState<Kind>("TECHNICAL");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [policyReason, setPolicyReason] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const readiness = useQuery<Readiness>({
    queryKey: [root + "/readiness", companyId],
    queryFn: () => read(root + "/readiness"),
    enabled: !!companyId,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const policy = useQuery<Policy>({
    queryKey: [root + "/policy", companyId],
    queryFn: () => read(root + "/policy"),
    enabled: !!companyId,
    retry: false,
  });
  const onError = (error: Error) =>
    toast({ title: "Release action refused", description: error.message, variant: "destructive" });
  const refresh = async () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: [root + "/readiness"] }),
      cache.invalidateQueries({ queryKey: [root + "/policy"] }),
    ]);
  const addReview = useMutation({
    mutationFn: async () => {
      if (!readiness.data?.deployedSha) throw new Error("No deployed SHA: full source revision must be available");
      const response = await apiRequest("POST", root + "/reviews", {
        kind: reviewKind,
        releaseSha: readiness.data.deployedSha,
        evidenceReference,
        notes: reviewNotes,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({
        title: "External evidence record saved",
        description: "This records human review; it does not independently verify CI or financial amounts",
      });
      setEvidenceReference("");
      setReviewNotes("");
      await refresh();
    },
    onError,
  });
  const revoke = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest("POST", root + "/reviews/" + id + "/revoke", {
        reason: revokeReason,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({ title: "Release review revoked; pilot authorization re-evaluated" });
      setRevokeReason("");
      await refresh();
    },
    onError,
  });
  const changeMode = useMutation({
    mutationFn: async (mode: Mode) => {
      const response = await apiRequest("POST", root + "/mode", {
        mode,
        releaseSha: mode === "METADATA_PILOT" ? (readiness.data?.deployedSha ?? null) : null,
        reason: policyReason,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({
        title: "Accounting release policy updated",
        description: "No voucher postings, currency changes or inventory cutover were activated",
      });
      setPolicyReason("");
      setConfirmation("");
      await refresh();
    },
    onError,
  });
  // Do not display or authorize controls from an in-flight response for a
  // previously selected company, even if a cache/browser boundary regresses.
  const d = readiness.data?.companyId === Number(companyId) ? readiness.data : undefined;
  const selectedPolicy = policy.data?.companyId === Number(companyId) ? policy.data : undefined;
  const selectedMode = selectedPolicy?.releaseMode ?? "READ_ONLY";
  const hasReview = (kind: Kind) => d?.releaseReviews.some((x) => x.kind === kind && !x.revoked);
  const pageForPhase = (phase: number, erpPath: string): string | null => {
    if (prefix === "/factory") {
      if (phase === 2) return "/factory/vouchers";
      if (phase === 6) return null; // ERP stock audit has no Factory route
      if (phase === 7) return "/factory/accounting/production";
      return "/factory" + erpPath;
    }
    if (prefix === "/properties") {
      if (phase === 2) return "/properties/vouchers";
      if (phase === 6 || phase === 7 || phase === 12) return null; // no native Property-mode stock/cost-center page
      return "/properties" + erpPath;
    }
    return erpPath;
  };
  const launchReady =
    !!d?.eligibleForExternalReview && !!d.reviewsComplete && !!d.deployedSha && d.metadataEntryReferencesCompatible;
  return (
    <div className="p-3 sm:p-5 space-y-5" data-testid="unified-accounting-rollout">
      <div>
        <h1 className="text-2xl font-semibold">Unified Accounting — Integration & Rollout</h1>
        <p className="text-sm text-muted-foreground">
          {selectedCompany?.name ?? "Selected company"} · Phase 15 · Company-specific read-only certification and
          Owner-governed metadata pilot
        </p>
      </div>
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
            <div className="grid sm:grid-cols-3 gap-3">
              <div>
                <Label>Review capacity</Label>
                <select
                  className="h-10 w-full rounded-md border bg-background px-2"
                  value={reviewKind}
                  onChange={(e) => setReviewKind(e.target.value as Kind)}
                >
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <Label>Evidence reference (CI run, audit or PR)</Label>
                <Input
                  value={evidenceReference}
                  onChange={(e) => setEvidenceReference(e.target.value)}
                  placeholder="Link or full traceable release evidence identifier"
                />
              </div>
              <div className="sm:col-span-3">
                <Label>What was independently reviewed?</Label>
                <Input
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  placeholder="Summarize actual checks and unresolved exceptions"
                />
              </div>
            </div>
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
        <Card>
          <CardHeader>
            <CardTitle>Owner-governed company rollout</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm">
              A metadata pilot would authorize only newly introduced matching, reconciliation, attribution and
              fiscal-review metadata routes after separate compatibility certification. The existing Cost Centers
              budget/attribution editors retain their own permissions and rollout controls. No setting here authorizes
              new financial GL posting, FX realization, inventory cutover, historical repairs or reviewed fiscal
              closing.
            </p>
            <p className="text-sm text-muted-foreground">
              Approved source revision: {selectedPolicy?.releaseSha ?? "None"}. Last decision:{" "}
              {selectedPolicy?.updatedAt ?? "Not configured"}.
            </p>
            <div>
              <Label>Owner's rollout decision and reason (10–1,000 characters)</Label>
              <Input
                value={policyReason}
                onChange={(e) => setPolicyReason(e.target.value)}
                placeholder="Why this company should enter or leave the metadata pilot"
              />
            </div>
            <div>
              <Label>Type APPROVE PILOT or RETURN READ ONLY</Label>
              <Input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                placeholder="Exact confirmation phrase"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                disabled={
                  !launchReady ||
                  selectedMode === "METADATA_PILOT" ||
                  confirmation !== "APPROVE PILOT" ||
                  policyReason.trim().length < 10 ||
                  changeMode.isPending
                }
                onClick={() => changeMode.mutate("METADATA_PILOT")}
              >
                Owner: approve metadata-only pilot
              </Button>
              <Button
                variant="outline"
                disabled={
                  selectedMode === "READ_ONLY" ||
                  confirmation !== "RETURN READ ONLY" ||
                  policyReason.trim().length < 10 ||
                  changeMode.isPending
                }
                onClick={() => changeMode.mutate("READ_ONLY")}
              >
                Owner: return to read-only
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Phase 15 deliberately keeps the new metadata writers locked until existing voucher-line replacement flows
              and metadata foreign keys are made compatible and independently certified. A pilot policy row cannot
              bypass this source-level safety gate. A future activation requires review of transaction-level
              approval-revocation races, not just a UI acknowledgement.
            </p>
            <p className="text-xs text-muted-foreground">
              If the deployed source SHA changes or any approval is revoked, the pilot writer gate fails closed at its
              next authorization check. Returning to read-only does not undo legitimate metadata. Existing ERP/Factory
              vouchers and other legacy business transactions continue under their normal posting and permissions.
            </p>
          </CardContent>
        </Card>
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
