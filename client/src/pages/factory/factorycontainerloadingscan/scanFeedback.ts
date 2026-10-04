/**
 * Scan feedback for the container loading scanner.
 *
 * The floor loader works with the screen out of view, so every scan outcome
 * gets its own tone. Extracted verbatim from FactoryContainerLoadingScan.tsx —
 * same frequencies, same durations, same silent fallback when the browser has
 * no AudioContext. The on-screen flash and result popups clear on timers
 * scheduled through useScanFlashReset.
 */
import { useCallback, useEffect, useRef } from "react";

function createAudioContext(): AudioContext | null {
  try {
    const W = (window as unknown as Window & typeof globalThis & { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
    return new (window.AudioContext || W)();
  } catch {
    return null; /* no audio support */
  }
}

/** Short square-ish beep at a fixed frequency. */
export function playScanBeep(frequency: number, durationMs: number): void {
  try {
    const ctx = createAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.frequency.value = frequency;
    ctx.resume().then(() => {
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, durationMs);
    });
  } catch {
    /* no audio support */
  }
}

/** Descending sawtooth sweep used for hard scan failures. */
export function playScanErrorSweep(): void {
  try {
    const ctx = createAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.connect(ctx.destination);
    ctx.resume().then(() => {
      osc.frequency.setValueAtTime(700, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(200, ctx.currentTime + 0.18);
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, 220);
    });
  } catch {
    /* no audio support */
  }
}

export const SCAN_SUCCESS_TONE = { frequency: 1000, durationMs: 120 };
export const SCAN_OVERLOAD_TONE = { frequency: 550, durationMs: 180 };
export const SCAN_NOT_IN_PROFORMA_TONE = { frequency: 600, durationMs: 180 };

/**
 * Schedules the scan flash and result-popup resets. They are timers that set
 * state, so any still pending are cleared when the page unmounts and none can
 * fire into a torn-down tree.
 */
export function useScanFlashReset(): (reset: () => void, delayMs: number) => void {
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  return useCallback((reset: () => void, delayMs: number) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      reset();
    }, delayMs);
    timersRef.current.add(timer);
  }, []);
}
