import { Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { useDialogScrollFix } from "@/hooks/use-dialog-scroll-fix";
import { useMobilePerformanceLifecycle } from "@/hooks/use-mobile-performance-lifecycle";
import { useLocation, Redirect } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useWsInvalidation } from "@/hooks/use-ws-invalidation";
import { LanguageOnboardingDialog } from "@/components/LanguageOnboardingDialog";
import { RemoteSupportRuntime } from "@/components/RemoteSupportRuntime";
import type { AuthenticatedUser } from "@/contracts/sessionContracts";
import { useAppNavigation } from "./useAppNavigation";
import { useAuthenticatedAppData } from "./useAuthenticatedAppData";
import { resolveAuthenticatedAppRoute } from "./authenticatedAppRouteGuard";
import { AppLeaveConfirmDialog } from "./AppLeaveConfirmDialog";
import { AppLoadingState } from "./AppLoadingState";
import { useErpScrollRestoration } from "./useErpScrollRestoration";

const PosShell = lazy(() => import("./PosShell").then((module) => ({ default: module.PosShell })));
const PropertiesShell = lazy(() => import("./PropertiesShell").then((module) => ({ default: module.PropertiesShell })));
const FactoryShell = lazy(() => import("./FactoryShell").then((module) => ({ default: module.FactoryShell })));
const ErpShell = lazy(() => import("./ErpShell").then((module) => ({ default: module.ErpShell })));

interface AuthenticatedAppProps {
  user: AuthenticatedUser;
  handleLogout: () => Promise<void>;
}

export function AuthenticatedApp({ user, handleLogout }: AuthenticatedAppProps) {
  const { selectedCompany, isLoading: companyLoading } = useCompany();
  useMobilePerformanceLifecycle();
  useWsInvalidation();
  useDialogScrollFix();

  const [currentLocation] = useLocation();
  useErpScrollRestoration(currentLocation);
  const { showLeaveConfirm, setShowLeaveConfirm, handleGoBack, handleConfirmLeave } = useAppNavigation();
  const isPOS = user.role === "POS";

  const { chatUnread, posImportEnabled, myAccess, myAccessLoading, myAccessError, factorySettings } =
    useAuthenticatedAppData({
      selectedCompanyId: selectedCompany?.id,
      companyType: selectedCompany?.companyType,
      userPresent: true,
      isPOS,
    });

  if (companyLoading || !selectedCompany) return <AppLoadingState />;

  const isAdminOwner = user.role === "Admin" || user.role === "Owner" || user.role === "Developer";
  const routeState = resolveAuthenticatedAppRoute({
    currentLocation,
    companyType: selectedCompany.companyType,
    isAdminOwner,
    myAccess,
    myAccessLoading,
    myAccessError,
    factorySettings,
  });

  if (routeState.decision.kind === "loading") return <AppLoadingState message="Loading Factory access" />;
  if (routeState.decision.kind === "bootstrap-error") {
    return <AppLoadingState message="Loading Factory access" showRecovery />;
  }
  if (routeState.decision.kind === "redirect") return <Redirect replace to={routeState.decision.to} />;

  const leaveConfirmDialog = (
    <AppLeaveConfirmDialog open={showLeaveConfirm} onOpenChange={setShowLeaveConfirm} onConfirm={handleConfirmLeave} />
  );
  const languageOnboarding = user.id === undefined ? null : <LanguageOnboardingDialog userId={user.id} />;
  const appOverlays = (
    <>
      {languageOnboarding}
      <RemoteSupportRuntime />
    </>
  );

  // The company switch is intentionally SPA-native, but company-owned pages can
  // still hold local component state and active query observers that were
  // created under the previous server session. Key the workspace shell to the
  // active company so a successful switch rebuilds that subtree immediately.
  // CompanyContext has already cancelled/removed the previous company's query
  // cache before committing this ID, so the remounted page fetches fresh data
  // for the new company without requiring a browser refresh.
  const companySessionKey = selectedCompany.id;

  if (isPOS) {
    return (
      <>
        <Suspense fallback={<AppLoadingState />}>
          <PosShell
            key={companySessionKey}
            user={user}
            posImportEnabled={posImportEnabled}
            chatUnread={chatUnread}
            handleGoBack={handleGoBack}
            handleLogout={handleLogout}
            leaveConfirmDialog={leaveConfirmDialog}
          />
        </Suspense>
        {appOverlays}
      </>
    );
  }

  if (routeState.isPropertiesCompany && routeState.isPropertiesRoute) {
    return (
      <>
        <Suspense fallback={<AppLoadingState />}>
          <PropertiesShell
            key={companySessionKey}
            user={user}
            currentLocation={currentLocation}
            handleLogout={handleLogout}
            leaveConfirmDialog={leaveConfirmDialog}
          />
        </Suspense>
        {appOverlays}
      </>
    );
  }

  if (routeState.isFactoryRoute || routeState.isFactoryCompany) {
    return (
      <>
        <Suspense fallback={<AppLoadingState />}>
          <FactoryShell
            key={companySessionKey}
            user={user}
            myAccess={myAccess}
            factoryDefaultPage={routeState.factoryDefaultPage}
            handleLogout={handleLogout}
            leaveConfirmDialog={leaveConfirmDialog}
          />
        </Suspense>
        {appOverlays}
      </>
    );
  }

  return (
    <>
      <Suspense fallback={<AppLoadingState />}>
        <ErpShell
          key={companySessionKey}
          user={user}
          hasErpAccess={routeState.hasErpAccess}
          handleLogout={handleLogout}
          leaveConfirmDialog={leaveConfirmDialog}
        />
      </Suspense>
      {appOverlays}
    </>
  );
}
