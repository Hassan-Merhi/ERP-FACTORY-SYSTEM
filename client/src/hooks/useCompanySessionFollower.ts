import { useEffect, type RefObject } from "react";
import type { Company } from "@/contexts/CompanyContext";
import type { CompanySwitchQueue } from "@/lib/companySwitchQueue";
import { subscribeToCompanySessionChanges } from "@/lib/companySessionSync";
import { cancelCompanySessionQueries, removeCompanySessionQueries } from "@/lib/companyQueryScope";
import { queryClient } from "@/lib/queryClient";
import { fetchSessionCompany } from "@/contracts/sessionQueryContracts";

interface CompanySessionFollowerOptions {
  companiesRef: RefObject<Company[]>;
  selectedCompanyRef: RefObject<Company | null>;
  switchQueueRef: RefObject<CompanySwitchQueue | null>;
  externalChangeObservedRef: RefObject<boolean>;
  onAdopt: (company: Company) => void;
}

/**
 * Follow the server session after another tab commits a company switch.
 *
 * Notifications are only hints; neither their payload nor localStorage can
 * authorize selection. A second session read inside the switch queue avoids
 * adopting an outdated observation while a local switch is in progress.
 */
export function useCompanySessionFollower({
  companiesRef,
  selectedCompanyRef,
  switchQueueRef,
  externalChangeObservedRef,
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
      if (!selectedCompanyRef.current && companiesRef.current.length === 0) return;
      inProgress = true;

      void (async () => {
        // Avoid entering the switching/loading state on every harmless focus.
        const initialSession = await fetchSessionCompany();
        if (disposed || !initialSession.companyId || initialSession.companyId === selectedCompanyRef.current?.id) return;

        await switchQueueRef.current!.enqueue(async () => {
          if (disposed) return;
          // A local or another tab's switch might have completed while this
          // task waited in the queue. Re-read the authoritative session.
          const { companyId } = await fetchSessionCompany();
          if (disposed || !companyId || companyId === selectedCompanyRef.current?.id) return;
          const company = companiesRef.current.find((candidate) => candidate.id === companyId);
          if (!company) return;

          await cancelCompanySessionQueries(queryClient);
          if (disposed) return;
          removeCompanySessionQueries(queryClient, { resetAuthenticatedUser: true });
          // Persist even if this was detected on resume rather than via storage;
          // otherwise a later reload could resurrect the old selection.
          onAdopt(company);
        });
      })()
        .catch((error: unknown) => {
          if (disposed) return;
          if (attempt < 3) {
            retryTimer = window.setTimeout(() => {
              retryTimer = null;
              reconcile(attempt + 1);
            }, 2000);
          } else {
            console.error("[Company] Could not reconcile the shared company session.", error);
          }
        })
        .finally(() => {
          inProgress = false;
          if (rerunRequested && !disposed) {
            rerunRequested = false;
            reconcile(0);
          }
        });
    };

    const onChange = () => {
      externalChangeObservedRef.current = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      // Storage and BroadcastChannel often fire for the same commit.
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
  }, [companiesRef, selectedCompanyRef, switchQueueRef, externalChangeObservedRef, onAdopt]);
}
