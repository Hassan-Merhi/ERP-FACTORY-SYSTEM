// Extracted from ./UnifiedAccountingRollout.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { kinds, read, root, type Kind, type Mode, type Policy, type Readiness } from "./UnifiedAccountingRolloutTypes";

export function useUnifiedAccountingRolloutState() {
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
  return {
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
  };
}

export function UnifiedAccountingRolloutSection({
  evidenceReference,
  reviewKind,
  reviewNotes,
  setEvidenceReference,
  setReviewKind,
  setReviewNotes,
}: Pick<
  ReturnType<typeof useUnifiedAccountingRolloutState>,
  "evidenceReference" | "reviewKind" | "reviewNotes" | "setEvidenceReference" | "setReviewKind" | "setReviewNotes"
>) {
  return (
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
  );
}
