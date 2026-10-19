import { Suspense, useEffect, useState } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";

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
 * Language selection is managed by the profile menu, without a blocking
 * first-login onboarding dialog. Remote support remains deferred.
 */
export function AuthenticatedAppOverlays() {
  const remoteSupportReady = useDeferredRemoteSupport();

  return (
    <Suspense fallback={null}>
      {remoteSupportReady ? <RemoteSupportRuntime /> : null}
    </Suspense>
  );
}
