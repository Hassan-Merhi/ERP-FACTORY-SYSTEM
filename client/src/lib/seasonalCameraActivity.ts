/**
 * Suspend decorative work while a barcode camera is capturing video.
 *
 * The factory pressing and shared mobile barcode scanners acquire leases only
 * after getUserMedia succeeds. Leases are ref-counted and idempotent so
 * closing one camera cannot reactivate effects if another is still capturing.
 * No camera stream, barcode, or credential is retained here.
 */
import { useSyncExternalStore } from "react";

let activeCaptures = 0;
const subscribers = new Set<() => void>();

function notify() {
  if (typeof document !== "undefined") {
    if (activeCaptures > 0) document.documentElement.dataset.seasonalCameraActive = "true";
    else delete document.documentElement.dataset.seasonalCameraActive;
  }
  for (const subscriber of subscribers) subscriber();
}

export function pauseSeasonalEffectsForCamera(): () => void {
  activeCaptures += 1;
  if (activeCaptures === 1) notify();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCaptures = Math.max(0, activeCaptures - 1);
    if (activeCaptures === 0) notify();
  };
}

export function isSeasonalCameraActive(): boolean {
  return activeCaptures > 0;
}

export function subscribeSeasonalCameraActivity(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function useSeasonalCameraActivity(): boolean {
  return useSyncExternalStore(subscribeSeasonalCameraActivity, isSeasonalCameraActive, () => false);
}
