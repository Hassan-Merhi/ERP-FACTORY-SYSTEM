/**
 * Shared motion / data-saver policy for purely decorative holiday animations.
 *
 * Static Christmas header/sidebar ornaments remain visible while animation
 * is suppressed. React subscriptions update live when a preference changes.
 */
import { useEffect, useState } from "react";

type SaveDataConnection = {
  saveData?: boolean;
  addEventListener?: (name: "change", listener: () => void) => void;
  removeEventListener?: (name: "change", listener: () => void) => void;
};

const MOTION_QUERIES = ["(prefers-reduced-motion: reduce)", "(prefers-reduced-data: reduce)"] as const;

function getSaveDataConnection(): SaveDataConnection | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: SaveDataConnection }).connection;
}

export function seasonalMotionRestricted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (typeof window.matchMedia === "function" && MOTION_QUERIES.some((query) => window.matchMedia(query).matches))
      return true;
  } catch {
    // A privacy-restricted or old browser may not support this query.
  }
  return getSaveDataConnection()?.saveData === true;
}

export function useSeasonalMotionRestricted(): boolean {
  const [restricted, setRestricted] = useState(seasonalMotionRestricted);

  useEffect(() => {
    const update = () => setRestricted(seasonalMotionRestricted());
    const cleanups: Array<() => void> = [];

    if (typeof window.matchMedia === "function") {
      for (const query of MOTION_QUERIES) {
        try {
          const media = window.matchMedia(query);
          if (typeof media.addEventListener === "function") {
            media.addEventListener("change", update);
            cleanups.push(() => media.removeEventListener("change", update));
          } else if (typeof media.addListener === "function") {
            // Legacy iOS Safari before the modern MediaQueryList change event.
            media.addListener(update);
            cleanups.push(() => media.removeListener(update));
          }
        } catch {
          // Ignore optional browser features rather than breaking the app.
        }
      }
    }

    const connection = getSaveDataConnection();
    connection?.addEventListener?.("change", update);
    if (connection?.removeEventListener) cleanups.push(() => connection.removeEventListener?.("change", update));
    update();

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  return restricted;
}
