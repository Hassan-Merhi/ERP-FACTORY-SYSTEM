import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient, setAppTimezone } from "@/lib/queryClient";
import {
  cancelCompanySessionQueries,
  isCompanySessionQueryKey,
  removeCompanySessionQueries,
} from "@/lib/companyQueryScope";
import { createCompanySwitchQueue, type CompanySwitchQueue } from "@/lib/companySwitchQueue";
import { publishCompanySessionCommit, type CompanySessionSignal } from "@/lib/companySessionSync";
import { announceCompanyWorkspaceTransition } from "@/lib/companyWorkspaceEvents";
import {
  activateCompanyCacheScope,
  beginCompanyCacheTransition,
  rememberVerifiedServerCompanyRevision,
  resumeCompanyCacheScope,
} from "@/lib/companyCacheScope";
import { useCompanySessionFollower } from "@/hooks/useCompanySessionFollower";
import { companyDataKey } from "@/lib/frontendDataArchitecture";
import { stableReferenceQueryPolicy } from "@/lib/queryPolicies";
import { refreshRealtimeSessionScope } from "@/hooks/use-ws-invalidation";
import { fetchSessionCompany, userCompaniesQueryOptions } from "@/contracts/sessionQueryContracts";
import type { CompanyType, UserCompanyAssignment } from "@/contracts/sessionContracts";

const PREFETCH_KEYS = [
  "/api/suppliers",
  "/api/customers",
  "/api/locations",
  "/api/employees",
  "/api/fixed-assets",
  "/api/stock-groups",
  "/api/stock-categories",
  "/api/stock-grades",
] as const;

// Ledger and bank accounts are intentionally not global reference prefetches.
// In Factory mode those shared endpoints are owned by accounting pages only;
// the pages that need them already query them explicitly when mounted.
function prefetchReferenceData(companyId: number, role?: string) {
  if (role === "POS") return;
  for (const url of PREFETCH_KEYS) {
    void queryClient.prefetchQuery({
      queryKey: companyDataKey(url, companyId),
      ...stableReferenceQueryPolicy,
    });
  }
}

export interface Company {
  id: number;
  code: string;
  name: string;
  active: boolean;
  role?: string;
  companyType: CompanyType;
  displayCurrency?: string | null;
  assignedLocationId?: number | null;
  posStation?: number | null;
  cashAccountId?: number | null;
  canSellNegativeStock?: boolean | null;
  posViewOnly?: boolean | null;
  daybookEditDays?: number | null;
  canAccessCustomers?: boolean | null;
  canDeleteRecords?: boolean | null;
}

export interface CompanySelectionOptions {
  offline?: boolean;
}

interface CompanyContextType {
  selectedCompany: Company | null;
  companies: Company[];
  isLoading: boolean;
  /** True while checking a resumed tab, without discarding unchanged forms. */
  isCheckingCompanySession: boolean;
  error: Error | null;
  selectCompany: (company: Company, options?: CompanySelectionOptions) => Promise<boolean>;
}

interface CompanyCommitOptions {
  prefetch: boolean;
  serverSynced: boolean;
  revision?: string | null;
  /** False when another tab already wrote the selection to localStorage. */
  persist?: boolean;
}

const CompanyContext = createContext<CompanyContextType | undefined>(undefined);

function mapCompanyAssignment(assignment: UserCompanyAssignment): Company {
  return {
    id: assignment.companyId,
    code: assignment.companyCode,
    name: assignment.companyName,
    active: assignment.companyActive,
    role: assignment.role,
    companyType: assignment.companyType,
    displayCurrency: assignment.displayCurrency,
    assignedLocationId: assignment.assignedLocationId,
    posStation: assignment.posStation,
    cashAccountId: assignment.cashAccountId,
    canSellNegativeStock: assignment.canSellNegativeStock,
    posViewOnly: assignment.posViewOnly,
    daybookEditDays: assignment.daybookEditDays,
    canAccessCustomers: assignment.canAccessCustomers,
    canDeleteRecords: assignment.canDeleteRecords,
  };
}

function parseSavedCompanyId(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function switchCompanyOnServer(companyId: number): Promise<{ ok: boolean; revision?: string }> {
  try {
    const response = await apiRequest("POST", "/api/auth/set-company", { companyId });
    let revision: string | undefined;
    if (response.ok && typeof response.json === "function") {
      try {
        const payload: unknown = await response.json();
        const value = (payload as { companyRevision?: unknown } | null)?.companyRevision;
        if (typeof value === "string") revision = value;
      } catch {
        // Older servers do not return a revision; use legacy compatibility.
      }
    }
    return { ok: response.ok, revision };
  } catch {
    return { ok: false };
  }
}

export function CompanyProvider({ children }: { children: ReactNode }) {
  const [selectedCompany, setSelectedCompany] = useState<Company | null>(null);
  const [isSyncingCompany, setIsSyncingCompany] = useState(false);
  const [externalSessionState, setExternalSessionState] = useState<"idle" | "checking" | "switching">("idle");
  const [initialSyncAttempt, setInitialSyncAttempt] = useState(0);
  const selectedCompanyRef = useRef<Company | null>(null);
  const lastSyncedCompanyId = useRef<number | null>(null);
  const initialSyncStarted = useRef(false);
  const externalChangeObservedRef = useRef(false);
  const initialRetryTimer = useRef<number | null>(null);
  const switchQueueRef = useRef<CompanySwitchQueue | null>(null);

  if (!switchQueueRef.current) {
    switchQueueRef.current = createCompanySwitchQueue((busy) => {
      if (busy) announceCompanyWorkspaceTransition();
      setIsSyncingCompany(busy);
    });
  }

  const {
    data: userCompanyAssignments = [],
    isLoading,
    error: companyAssignmentsError,
  } = useQuery(userCompaniesQueryOptions());

  const companies: Company[] = userCompanyAssignments
    .filter((assignment) => assignment.companyActive === true)
    .map(mapCompanyAssignment)
    .filter(
      (company, index, allCompanies) => index === allCompanies.findIndex((candidate) => candidate.id === company.id)
    );
  const companiesRef = useRef(companies);
  companiesRef.current = companies;

  const commitCompanySelection = useCallback((company: Company, options: CompanyCommitOptions) => {
    activateCompanyCacheScope(company.id);
    if (options.serverSynced) rememberVerifiedServerCompanyRevision(company.id, options.revision);
    setAppTimezone(null);
    lastSyncedCompanyId.current = options.serverSynced ? company.id : null;
    selectedCompanyRef.current = company;
    setSelectedCompany(company);
    if (options.persist !== false) localStorage.setItem("selectedCompanyId", company.id.toString());
    if (options.prefetch) prefetchReferenceData(company.id, company.role);
  }, []);

  /**
   * Adopts the company the server session already points at.
   *
   * This is not a switch: no request has gone anywhere else, so there is
   * nothing stale to clear. Cancelling and removing here used to abort every
   * query the page had already started — the sidebar, the route's own data —
   * and then drop their cache entries, so each page loaded twice on entry and
   * the aborted requests surfaced as "the operation was aborted" errors. The
   * cache is in-memory only and logout clears it, so anything already fetched
   * belongs to this user and this company. Just commit the selection.
   */
  const adoptServerCompany = useCallback(
    (company: Company, revision?: string | null) => {
      commitCompanySelection(company, { prefetch: true, serverSynced: true, revision });
    },
    [commitCompanySelection]
  );

  const performCompanySelection = useCallback(
    async (company: Company, options: CompanySelectionOptions = {}): Promise<boolean> => {
      if (selectedCompanyRef.current?.id === company.id) {
        if (options.offline || lastSyncedCompanyId.current === company.id) return true;
      }

      const isInitialActivation = selectedCompanyRef.current === null;
      let refusedSwitch = false;
      if (!isInitialActivation) beginCompanyCacheTransition();
      try {
        await cancelCompanySessionQueries(queryClient);

        if (options.offline) {
          removeCompanySessionQueries(queryClient, {
            resetAuthenticatedUser: !isInitialActivation,
          });
          commitCompanySelection(company, { prefetch: false, serverSynced: false });
          return true;
        }

        const switched = await switchCompanyOnServer(company.id);
        if (!switched.ok) {
          refusedSwitch = true;
          return false;
        }

        removeCompanySessionQueries(queryClient, {
          resetAuthenticatedUser: !isInitialActivation,
        });
        commitCompanySelection(company, { prefetch: true, serverSynced: true, revision: switched.revision });
        publishCompanySessionCommit(company.id);
        // The WebSocket's company/user scope is captured when it connects. Since
        // company switching is now SPA-native (no page reload), replace the socket
        // after the server session changes so realtime events follow this company.
        refreshRealtimeSessionScope();

        if (isInitialActivation) {
          void queryClient.invalidateQueries({
            queryKey: ["/api/auth/me"],
            exact: true,
            refetchType: "active",
          });
        }

        return true;
      } finally {
        // A denied switch or transport error must reopen the existing
        // company's read scope without exposing a stale in-flight response.
        resumeCompanyCacheScope();
        // Do not start recovery reads until the old company's scope is
        // verified again. They would otherwise fail against transition mode.
        if (refusedSwitch) {
          void queryClient.invalidateQueries({
            predicate: (query) => isCompanySessionQueryKey(query.queryKey),
            refetchType: "active",
          });
        }
      }
    },
    [commitCompanySelection]
  );

  const selectCompany = useCallback(
    (company: Company, options: CompanySelectionOptions = {}) =>
      switchQueueRef.current!.enqueue(() => performCompanySelection(company, options)),
    [performCompanySelection]
  );

  const scheduleInitialSyncRetry = useCallback(() => {
    if (initialRetryTimer.current !== null) return;
    initialRetryTimer.current = window.setTimeout(() => {
      initialRetryTimer.current = null;
      initialSyncStarted.current = false;
      setInitialSyncAttempt((attempt) => attempt + 1);
    }, 2000);
  }, []);

  useEffect(
    () => () => {
      if (initialRetryTimer.current !== null) window.clearTimeout(initialRetryTimer.current);
    },
    []
  );

  useEffect(() => {
    if (companies.length === 0 || selectedCompany || initialSyncStarted.current) return;

    const savedCompanyId = parseSavedCompanyId(localStorage.getItem("selectedCompanyId"));
    const savedCompany = savedCompanyId ? companies.find((company) => company.id === savedCompanyId) : undefined;
    const target = savedCompany ?? companies[0];
    if (!target) return;

    initialSyncStarted.current = true;

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      void selectCompany(target, { offline: true }).catch((error: unknown) => {
        console.error("[Company] Failed to activate the offline company selection.", error);
        scheduleInitialSyncRetry();
      });
      return;
    }

    void fetchSessionCompany()
      .catch(() => ({ companyId: null, companyRevision: undefined }))
      .then(async ({ companyId: sessionCompanyId, companyRevision }) => {
        if (selectedCompanyRef.current) return;
        // A confirmed external switch during bootstrap takes precedence over a
        // saved startup preference. Do not write the session back to an old tab.
        if (externalChangeObservedRef.current) {
          const serverCompany = companiesRef.current.find((company) => company.id === sessionCompanyId);
          if (serverCompany) {
            await switchQueueRef.current!.enqueue(async () => {
              if (!selectedCompanyRef.current) adoptServerCompany(serverCompany, companyRevision);
            });
            return;
          }
        }
        if (sessionCompanyId === target.id) {
          await switchQueueRef.current!.enqueue(async () => {
            adoptServerCompany(target, companyRevision);
          });
          return;
        }

        const ok = await selectCompany(target);
        if (ok) return;

        const serverCompany = companies.find((company) => company.id === sessionCompanyId);
        if (serverCompany) {
          // The switch was refused, so the session still points where it did
          // and the requests already in flight were made against it.
          await switchQueueRef.current!.enqueue(async () => {
            adoptServerCompany(serverCompany);
          });
          return;
        }

        console.error("[Company] Failed to synchronize the initial company selection; retrying.");
        scheduleInitialSyncRetry();
      })
      .catch((error: unknown) => {
        console.error("[Company] Initial company synchronization failed; retrying.", error);
        scheduleInitialSyncRetry();
      });
  }, [adoptServerCompany, companies, initialSyncAttempt, scheduleInitialSyncRetry, selectCompany, selectedCompany]);

  const adoptOtherTabCompany = useCallback((company: Company, revision?: string | null) => {
    commitCompanySelection(company, { prefetch: true, serverSynced: true, revision });
    refreshRealtimeSessionScope();
  }, [commitCompanySelection]);

  const beginExternalSessionVerification = useCallback((signal: CompanySessionSignal) => {
    beginCompanyCacheTransition();
    if (signal === "selection") announceCompanyWorkspaceTransition();
    setExternalSessionState((current) =>
      signal === "selection" || current === "switching" ? "switching" : "checking"
    );
  }, []);
  const finishExternalSessionVerification = useCallback(() => {
    resumeCompanyCacheScope();
    setExternalSessionState("idle");
  }, []);
  const rememberExternalSessionRevision = useCallback((companyId: number, revision?: string | null) => {
    rememberVerifiedServerCompanyRevision(companyId, revision);
  }, []);

  useCompanySessionFollower({
    companiesRef,
    selectedCompanyRef,
    switchQueueRef,
    externalChangeObservedRef,
    onTransitionStart: beginExternalSessionVerification,
    onTransitionVerified: finishExternalSessionVerification,
    onVerifiedScope: rememberExternalSessionRevision,
    onAdopt: adoptOtherTabCompany,
  });

  return (
    <CompanyContext.Provider
      value={{
        selectedCompany,
        companies,
        isLoading:
          isLoading || isSyncingCompany || externalSessionState === "switching" || (companies.length > 0 && !selectedCompany),
        // Pending local changes stay covered rather than unmounting forms.
        // A confirmed external company mismatch still hard-gates the workspace.
        isCheckingCompanySession:
          externalSessionState !== "switching" && (externalSessionState === "checking" || isSyncingCompany),
        error: companyAssignmentsError instanceof Error ? companyAssignmentsError : null,
        selectCompany,
      }}
    >
      {children}
    </CompanyContext.Provider>
  );
}

/** Optional context for standalone product-table renderers and unit tests. */
export function useOptionalCompany() {
  return useContext(CompanyContext);
}

export function useCompany() {
  const context = useContext(CompanyContext);
  if (context === undefined) {
    throw new Error("useCompany must be used within a CompanyProvider");
  }
  return context;
}
