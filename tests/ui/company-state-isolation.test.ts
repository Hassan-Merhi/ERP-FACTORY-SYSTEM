import { resolve } from "node:path";
import { readModuleFamily } from "../../scripts/lib/readModuleFamily.mjs";

function source(path: string): string {
  return readModuleFamily(resolve(process.cwd(), path));
}

describe("frontend company-state isolation wiring", () => {
  it("routes every selector change through CompanyContext without reloading", () => {
    const selector = source("client/src/components/CompanySelector.tsx");

    expect(selector).toContain("await selectCompany(company");
    expect(selector).toContain("{ offline: true }");
    expect(selector).not.toContain("window.location.reload");
    expect(selector).not.toContain('apiRequest("POST", "/api/auth/set-company"');
  });

  it("serializes switches and clears previous-company requests and caches", () => {
    const context = source("client/src/contexts/CompanyContext.tsx");

    expect(context).toContain("createCompanySwitchQueue");
    expect(context).toContain("cancelCompanySessionQueries(queryClient)");
    expect(context).toContain("removeCompanySessionQueries(queryClient, {");
    expect(context).toContain("const ok = await switchCompanyOnServer(company.id)");
    expect(context).toContain("commitCompanySelection(company, { prefetch: true, serverSynced: true })");
    expect(context).toContain("commitCompanySelection(company, { prefetch: false, serverSynced: false })");
    expect(context).toContain("scheduleInitialSyncRetry");
    expect(context).not.toContain("invalidateCompanyQueries");
  });

  it("adopts the session's own company without cancelling the requests already in flight", () => {
    const context = source("client/src/contexts/CompanyContext.tsx");

    // Adopting the company the server session already points at is not a
    // switch: nothing stale exists to clear. Cancelling there aborted the
    // queries the page had just started and dropped their cache entries, so
    // every page loaded twice on entry.
    expect(context).toContain("adoptServerCompany");
    const adoption = context.slice(context.indexOf("const adoptServerCompany"));
    const adoptionBody = adoption.slice(0, adoption.indexOf("const performCompanySelection"));
    expect(adoptionBody).not.toContain("cancelCompanySessionQueries");
    expect(adoptionBody).not.toContain("removeCompanySessionQueries");
  });

  it("does not abort in-flight requests on blanket invalidation", () => {
    // These fire on every write anywhere in the system. React Query defaults
    // cancelRefetch to true, which aborts and restarts every request already
    // on its way — doubling the load and surfacing the aborts as failures.
    for (const path of [
      "client/src/hooks/use-ws-invalidation.ts",
      "client/src/contexts/ConnectivityContext.tsx",
      "client/src/contexts/ApplicationLanguageContext.tsx",
    ]) {
      expect(source(path)).toContain("cancelRefetch: false");
    }
  });

  it("blocks every authenticated workspace while the company session changes", () => {
    const app = source("client/src/app/AuthenticatedApp.tsx");
    const appData = source("client/src/app/useAuthenticatedAppData.ts");

    expect(app).toContain("if (!selectedCompany || (companyLoading && !isCheckingCompanySession)) return <AppLoadingState />;");
    expect(appData).toContain('companyQueryKey("/api/company-settings", selectedCompanyId)');
    expect(appData).toContain('companyQueryKey("/api/factory/my-access", selectedCompanyId)');
    expect(appData).toContain('companyQueryKey("/api/factory/settings", selectedCompanyId)');
  });

  it("gates all company-specific providers and portals before showing old records", () => {
    const root = source("client/src/App.tsx");
    const context = source("client/src/contexts/CompanyContext.tsx");
    const follower = source("client/src/hooks/useCompanySessionFollower.ts");

    expect(root).toContain("function CompanyWorkspaceBoundary(");
    expect(root).toContain('if (!selectedCompany || (companyLoading && !isCheckingCompanySession))');
    expect(root).toContain('data-testid="company-session-verification-cover"');
    expect(root).toContain("isCheckingCompanySession && <CompanySessionVerificationCover />");
    expect(root).toContain('<LocationProvider key={`${user.id}:${selectedCompany.id}`}>');
    expect(root).toContain("<LegacyQueueRecoveryPanel />");
    expect(root).toContain("<DeferredAuthenticatedUtilities />");
    expect(context).toContain('externalSessionState === "switching"');
    expect(context).toContain('externalSessionState !== "switching" && (externalSessionState === "checking" || isSyncingCompany)');
    expect(follower).toContain('onTransitionStart("selection")');
    expect(follower).toContain("onTransitionVerified()");
  });

  it("clears global confirmations and toast notices during actual company transitions", () => {
    const context = source("client/src/contexts/CompanyContext.tsx");
    const confirmHost = source("client/src/components/ConfirmHost.tsx");
    const toaster = source("client/src/components/ui/toaster.tsx");

    expect(context).toContain("announceCompanyWorkspaceTransition()");
    expect(confirmHost).toContain("COMPANY_WORKSPACE_TRANSITION_EVENT");
    expect(confirmHost).toContain("request.resolve(false)");
    expect(confirmHost).toContain("request.resolve(null)");
    expect(toaster).toContain("COMPANY_WORKSPACE_TRANSITION_EVENT, clearAllToasts");
  });

  it("remounts the active workspace when the company identity changes", () => {
    const app = source("client/src/app/AuthenticatedApp.tsx");

    expect(app).toContain("const companySessionKey = selectedCompany.id;");
    expect(app).toContain("<PosShell\n            key={companySessionKey}");
    expect(app).toContain("<PropertiesShell\n            key={companySessionKey}");
    expect(app).toContain("<FactoryShell\n            key={companySessionKey}");
    expect(app).toContain("<ErpShell\n          key={companySessionKey}");
  });

  it("scopes company-transfer history, account options, and rules", () => {
    const transfers = source("client/src/pages/CompanyTransfer.tsx");

    expect(transfers).toContain("companyKeys.simpleTransfers(fromCompanyId)");
    expect(transfers).toContain("companyKeys.companyAccounts(fromCompanyId, fromCompanyId)");
    expect(transfers).toContain("companyKeys.companyAccounts(fromCompanyId, ruleDestCompanyId || null)");
    expect(transfers).toContain("companyKeys.autoTransferConfig(fromCompanyId");
    expect(transfers).not.toContain('queryKey: ["/api/simple-company-transfers"]');
  });
});
