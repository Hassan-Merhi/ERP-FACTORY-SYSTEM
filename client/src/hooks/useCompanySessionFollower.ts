import { useEffect, type RefObject } from "react";
import type { Company } from "@/contexts/CompanyContext";
import type { CompanySwitchQueue } from "@/lib/companySwitchQueue";
import { subscribeToCompanySessionChanges, type CompanySessionSignal } from "@/lib/companySessionSync";
import { cancelCompanySessionQueries, removeCompanySessionQueries } from "@/lib/companyQueryScope";
import { queryClient } from "@/lib/queryClient";
import { fetchSessionCompany } from "@/contracts/sessionQueryContracts";

// Machine-readable diagnostics, not user-facing copy. Keep them out of Error
// literal arguments so the UI translation audit treats them as identifiers.
const COMPANY_SESSION_ERROR_CODES = {
  unavailable: "COMPANY_SESSION_UNAVAILABLE",
  unassigned: "COMPANY_SESSION_UNASSIGNED",
} as const;

interface CompanySessionFollowerOptions {
  companiesRef: RefObject<Company[]>;
  selectedCompanyRef: RefObject<Company | null>;
  switchQueueRef: RefObject<CompanySwitchQueue | null>;
  externalChangeObservedRef: RefObject<boolean>;
  /** Hide the current workspace before any session probe can resolve. */
  onTransitionStart: (signal: CompanySessionSignal | "hint") => void;
  /** Reveal the workspace only after the server scope was verified. */
  onTransitionVerified: () => void;
  onVerifiedScope: (companyId: number, revision?: string | null) => void;
  onAdopt: (company: Company, revision?: string | null) => void;
}

/**
 * Other tabs share a server session but not React state. Treat every switch
 * notification and tab resume as a possible scope change. Hide old data until
 * a fresh server read (and, if needed, cache eviction) has completed.
 */
export function useCompanySessionFollower({
  companiesRef,
  selectedCompanyRef,
  switchQueueRef,
  externalChangeObservedRef,
  onTransitionStart,
  onTransitionVerified,
  onVerifiedScope,
  onAdopt,
}: CompanySessionFollowerOptions): void {
  useEffect(() => {
    let disposed = false;
    let inProgress = false;
    let rerunRequested = false;
    let retryTimer: number | null = null;
    let debounceTimer: number | null = null;

    const reconcile = (attempt: number) => {
      if (disposed || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
      if (inProgress) {
        rerunRequested = true;
        return;
      }
      if (!selectedCompanyRef.current || companiesRef.current.length === 0) return;

      inProgress = true;
      let verified = false;
      let verifiedCompanyId: number | null = null;
      let verifiedRevision: string | null | undefined;
      void (async () => {
        // Do not trust the broadcast's company ID or browser storage. The
        // authenticated server session is the authoritative identity.
        const initialSession = await fetchSessionCompany();
        if (disposed) return;
        if (!initialSession.companyId) throw new Error(COMPANY_SESSION_ERROR_CODES.unavailable);
        verifiedCompanyId = initialSession.companyId;
        verifiedRevision = initialSession.companyRevision;

        if (initialSession.companyId !== selectedCompanyRef.current?.id) {
          // A resume probe detected an actual change: unmount all old-company
          // UI before admitting any newly scoped business responses.
          onTransitionStart("selection");
          await switchQueueRef.current!.enqueue(async () => {
            if (disposed) return;
            // Another local switch may have completed while waiting in the
            // queue; always re-read after obtaining the session boundary.
            const { companyId, companyRevision } = await fetchSessionCompany();
            if (disposed) return;
            verifiedCompanyId = companyId;
            verifiedRevision = companyRevision;
            const company = companiesRef.current.find((candidate) => candidate.id === companyId);
            if (!company) throw new Error(COMPANY_SESSION_ERROR_CODES.unassigned);
            if (company.id === selectedCompanyRef.current?.id) return;

            await cancelCompanySessionQueries(queryClient);
            if (disposed) return;
            removeCompanySessionQueries(queryClient, { resetAuthenticatedUser: true });
            onAdopt(company, companyRevision);
          });
        }
        if (!disposed) verified = true;
      })()
        .catch((error: unknown) => {
          if (disposed) return;
          // Fail closed. After retries are exhausted, the loading state offers
          // recovery instead of exposing records under an unverified session.
          if (attempt < 3 && !rerunRequested) {
            retryTimer = window.setTimeout(() => {
              retryTimer = null;
              reconcile(attempt + 1);
            }, 2000);
          } else if (!rerunRequested) {
            console.error("[Company] Could not verify the shared company session.", error);
          }
        })
        .finally(() => {
          inProgress = false;
          if (disposed) return;
          if (rerunRequested) {
            rerunRequested = false;
            if (retryTimer !== null) window.clearTimeout(retryTimer);
            retryTimer = null;
            reconcile(0);
          } else if (verified && verifiedCompanyId !== null) {
            onTransitionVerified();
            onVerifiedScope(verifiedCompanyId, verifiedRevision);
          }
        });
    };

    const onChange = (signal: CompanySessionSignal) => {
      // Initial pageshow/focus is not an external switch; preserve the saved
      // startup company until a real selection notification arrives.
      if (signal === "selection") externalChangeObservedRef.current = true;
      // During first activation the entire app is already hidden. Its startup
      // path reconciles the server, so do not introduce a permanent second gate.
      if (!selectedCompanyRef.current) return;
      // A cross-tab commit hint needs immediate privacy protection. Ordinary
      // tab resumes keep reads/writes fenced but delay the visible cover; only
      // a confirmed mismatch discards drafts and changes the workspace.
      onTransitionStart(signal === "selection" ? "hint" : "resume");
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      if (inProgress) {
        // A second focus/visibility event during the same in-flight resume
        // is not a new session change; avoid a self-sustaining check loop.
        if (signal === "selection") rerunRequested = true;
        return;
      }
      if (debounceTimer !== null) return;
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        reconcile(0);
      }, 0);
    };

    const unsubscribe = subscribeToCompanySessionChanges(onChange);
    return () => {
      disposed = true;
      unsubscribe();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    };
  }, [
    companiesRef,
    selectedCompanyRef,
    switchQueueRef,
    externalChangeObservedRef,
    onTransitionStart,
    onTransitionVerified,
    onVerifiedScope,
    onAdopt,
  ]);
}
