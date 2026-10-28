import "@/styles/rtl-hardening.css";
import "@/styles/pos-revision-history.css";
import { Suspense, useEffect, useRef, useState } from "react";
import { Redirect, Switch, Route } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { ConfirmHost } from "@/components/ConfirmHost";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ConnectivityProvider } from "@/contexts/ConnectivityContext";
import { CompanyProvider } from "@/contexts/CompanyContext";
import { LocationProvider } from "@/contexts/LocationContext";
import { DateFormatProvider } from "@/contexts/DateFormatContext";
import { CurrencyProvider } from "@/contexts/CurrencyContext";
import { CursorNavProvider } from "@/contexts/CursorNavContext";
import { ApplicationLanguageProvider } from "@/contexts/ApplicationLanguageContext";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { useServerRestart } from "@/hooks/use-server-restart";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { AuthenticatedApp } from "@/app/AuthenticatedApp";
import { AppLoadingState } from "@/app/AppLoadingState";
import { useAuthenticatedUser } from "@/app/useAuthenticatedUser";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { applyGlobalForceRefresh, shouldApplyGlobalForceRefresh } from "@/lib/globalForceRefresh";

const Login = lazy(() => import("@/pages/Login"));
const ChatWidget = lazy(() => import("@/components/ChatWidget").then((module) => ({ default: module.ChatWidget })));
const UserNotesPanel = lazy(() =>
  import("@/components/UserNotesPanel").then((module) => ({ default: module.UserNotesPanel }))
);
const DateJumpDialog = lazy(() =>
  import("@/components/DateJumpDialog").then((module) => ({ default: module.DateJumpDialog }))
);
const KeyboardShortcuts = lazy(() =>
  import("@/components/KeyboardShortcuts").then((module) => ({ default: module.KeyboardShortcuts }))
);

function useIdleAuthenticatedUtilities() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let timer: number | null = null;
    let idleCallback: number | null = null;

    if (typeof window.requestIdleCallback === "function") {
      idleCallback = window.requestIdleCallback(() => setReady(true), { timeout: 1200 });
    } else {
      timer = window.setTimeout(() => setReady(true), 250);
    }

    return () => {
      if (idleCallback !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleCallback);
      }
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return ready;
}

function UpdateBanner() {
  const { toast } = useToast();
  const notifiedRef = useRef(false);
  const initialVersionRef = useRef<string | null>(null);
  const checkingRef = useRef(false);

  useEffect(() => {
    if (import.meta.env.DEV) return;

    async function checkVersion() {
      // An unauthenticated login page is not a target of the admin command.
      if (window.location.pathname === "/login" || window.location.pathname.startsWith("/login/")) return;
      if (checkingRef.current) return;
      checkingRef.current = true;
      try {
        const res = await fetch("/api/build-info", { credentials: "same-origin", cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        // The server provides the current session's role-scoped refresh token
        // (regular users OR admins/owners/developers). Each tab watches only its
        // own group and shows the five-second notice when that token changes.
        if (
          typeof data.forceRefreshToken === "string" &&
          shouldApplyGlobalForceRefresh(data.forceRefreshToken)
        ) {
          void applyGlobalForceRefresh(data.forceRefreshToken);
          return;
        }
        const ver: string = data.version ?? "";
        if (!ver || ver === "dev") return;

        if (initialVersionRef.current === null) {
          initialVersionRef.current = ver;
          return;
        }

        if (ver !== initialVersionRef.current && !notifiedRef.current) {
          notifiedRef.current = true;
          toast({
            title: "Update available",
            description: "A new version of the app is ready.",
            duration: 0,
            action: (
              <Button
                size="sm"
                variant="outline"
                data-testid="button-update-refresh"
                onClick={() => {
                  try {
                    const prefixes = ["assetRecovery:", "swReload:", "chunkReload:", "chunkRetry:"];
                    Object.keys(sessionStorage)
                      .filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
                      .forEach((key) => sessionStorage.removeItem(key));
                  } catch {
                    /* ignore */
                  }
                  window.location.reload();
                }}
              >
                Refresh
              </Button>
            ),
          });
        }
      } catch {
        /* network error — ignore, will retry next interval */
      } finally {
        checkingRef.current = false;
      }
    }

    const handleServiceWorkerUpdate = () => {
      void checkVersion();
    };

    void checkVersion();
    // Visible desktop/mobile sessions react within 15 seconds. Browsers may
    // suspend background tabs; checking on focus/visibility catches them on return.
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void checkVersion();
    }, 15_000);
    const checkOnResume = () => {
      if (document.visibilityState === "visible") void checkVersion();
    };
    window.addEventListener("erp:service-worker-updated", handleServiceWorkerUpdate);
    window.addEventListener("erp:check-build-info", handleServiceWorkerUpdate);
    window.addEventListener("focus", checkOnResume);
    document.addEventListener("visibilitychange", checkOnResume);
    return () => {
      clearInterval(id);
      window.removeEventListener("erp:service-worker-updated", handleServiceWorkerUpdate);
      window.removeEventListener("erp:check-build-info", handleServiceWorkerUpdate);
      window.removeEventListener("focus", checkOnResume);
      document.removeEventListener("visibilitychange", checkOnResume);
    };
  }, [toast]);

  return null;
}

function AuthenticatedUserNotesPanel() {
  const { prefs } = useUserPreferences();
  if (prefs && prefs.showNotesPanel === false) return null;
  return <UserNotesPanel />;
}

function AuthenticatedChatWidget() {
  const { prefs } = useUserPreferences();
  if (prefs && prefs.showChatWidget === false) return null;
  return <ChatWidget />;
}

function ServerRestartWatcher() {
  useServerRestart();
  return null;
}

function DeferredAuthenticatedUtilities() {
  const ready = useIdleAuthenticatedUtilities();
  if (!ready) return null;

  return (
    <Suspense fallback={null}>
      <AuthenticatedChatWidget />
      <DateJumpDialog />
      <AuthenticatedUserNotesPanel />
      <KeyboardShortcuts />
    </Suspense>
  );
}

function AuthenticatedRoot() {
  const { user, isLoading, error, handleLogout } = useAuthenticatedUser();

  // fetchAuthenticatedUser returns null only for a confirmed 401. Temporary
  // network/server failures remain errors and must never masquerade as logout.
  if (!isLoading && !error && user === null) return <Redirect to="/login" />;
  if (isLoading || error || !user) {
    return <AppLoadingState message={error ? "Reconnecting to your session" : undefined} />;
  }

  return (
    <ApplicationLanguageProvider>
      <CompanyProvider>
        <LocationProvider>
          <DateFormatProvider>
            <CurrencyProvider>
              <CursorNavProvider>
                <ServerRestartWatcher />
                <AuthenticatedApp user={user} handleLogout={handleLogout} />
                <DeferredAuthenticatedUtilities />
              </CursorNavProvider>
            </CurrencyProvider>
          </DateFormatProvider>
        </LocationProvider>
      </CompanyProvider>
    </ApplicationLanguageProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeProvider>
          <ConnectivityProvider>
            <Switch>
              <Route path="/login">
                <ApplicationLanguageProvider>
                  <Suspense fallback={<AppLoadingState />}>
                    <Login />
                  </Suspense>
                </ApplicationLanguageProvider>
              </Route>
              <Route>
                <AuthenticatedRoot />
              </Route>
            </Switch>
            <Toaster />
            <ConfirmHost />
            <UpdateBanner />
          </ConnectivityProvider>
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
