import { Suspense, useEffect, useState } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";

const LanguageOnboardingDialog = lazy(() =>
  import("@/components/LanguageOnboardingDialog").then((module) => ({
    default: module.LanguageOnboardingDialog,
  }))
);
const RemoteSupportRuntime = lazy(() =>
  import("@/components/RemoteSupportRuntime").then((module) => ({
    default: module.RemoteSupportRuntime,
  }))
);

function useDeferredRemoteSupport() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let timer: number | null = null;
    let idleCallback: number | null = null;

    if (typeof window.requestIdleCallback === "function") {
      idleCallback = window.requestIdleCallback(() => setReady(true), { timeout: 1800 });
    } else {
      timer = window.setTimeout(() => setReady(true), 400);
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

/**
 * Global overlays rendered above every workspace shell.
 *
 * Language onboarding stays available immediately for first-run users. Remote
 * support is non-blocking infrastructure, so its network/capture runtime is
 * loaded after the authenticated workspace gets an idle turn.
 */
export function AuthenticatedAppOverlays({ userId }: { userId: number | string | undefined }) {
  const remoteSupportReady = useDeferredRemoteSupport();

  return (
    <Suspense fallback={null}>
      {userId === undefined ? null : <LanguageOnboardingDialog userId={userId} />}
      {remoteSupportReady ? <RemoteSupportRuntime /> : null}
    </Suspense>
  );
}
