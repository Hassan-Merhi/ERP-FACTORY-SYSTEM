import "@/styles/rtl-hardening.css";
import "@/styles/pos-revision-history.css";
import { Suspense, useEffect, useRef, useState } from "react";
import { Redirect, Switch, Route } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
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

const Login = lazy(() => import("@/pages/Login"));
const ChatWidget = lazy(() =>
  import("@/components/ChatWidget").then((module) => ({ default: module.ChatWidget }))
);
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

  useEffect(() => {
    if (import.meta.env.DEV) return;

    async function checkVersion() {
      try {
        const res = await fetch("/api/build-info", { credentials: "same-origin" });
        if (!res.ok) return;
        const data = await res.json();
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
      }
    }

    const handleServiceWorkerUpdate = () => {
      void checkVersion();
    };

    void checkVersion();
    const id = setInterval(checkVersion, 5 * 60 * 1000);
    window.addEventListener("erp:service-worker-updated", handleServiceWorkerUpdate);
    return () => {
      clearInterval(id);
      window.removeEventListener("erp:service-worker-updated", handleServiceWorkerUpdate);
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
            <UpdateBanner />
          </ConnectivityProvider>
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
