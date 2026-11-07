import { Suspense, useEffect, useState } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { FactoryLanOriginBadge } from "@/components/FactoryLanOriginBadge";
import { GlobalSnowfall } from "@/components/GlobalSnowfall";
import { GlobalSeasonalDecorations } from "@/components/GlobalSeasonalDecorations";
import { useChristmasMode, defaultChristmasVisuals } from "@/hooks/useChristmasMode";
import { ChristmasLoginEntrance } from "@/components/ChristmasLoginEntrance";
import { ChristmasSleighFlyover } from "@/components/ChristmasSleighFlyover";
import { ChristmasVisualExtras } from "@/components/ChristmasVisualExtras";
import { useSeasonalCameraActivity } from "@/lib/seasonalCameraActivity";

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
  const { settingQuery } = useChristmasMode();
  const christmasModeEnabled = settingQuery.data?.enabled === true;
  const visuals = settingQuery.data?.visuals ?? defaultChristmasVisuals;
  const cameraActive = useSeasonalCameraActivity();
  const allowSeasonalAnimations = christmasModeEnabled && !cameraActive;

  return (
    <>
      <FactoryLanOriginBadge />
      <GlobalSeasonalDecorations
        enabled={christmasModeEnabled}
        garlands={visuals.effects.garlands}
        snowCaps={visuals.effects.snowfall}
        intensity={visuals.intensity}
      />
      <GlobalSnowfall enabled={allowSeasonalAnimations && visuals.effects.snowfall} intensity={visuals.intensity} />
      <ChristmasSleighFlyover enabled={allowSeasonalAnimations && visuals.effects.santa} />
      <ChristmasVisualExtras
        enabled={christmasModeEnabled}
        countdown={visuals.effects.countdown}
        gifts={allowSeasonalAnimations && visuals.effects.gifts}
        ambient={visuals.effects.ambient}
        intensity={visuals.intensity}
      />
      <ChristmasLoginEntrance enabled={allowSeasonalAnimations} queryStatus={settingQuery.status} />
      <Suspense fallback={null}>{remoteSupportReady ? <RemoteSupportRuntime /> : null}</Suspense>
    </>
  );
}
