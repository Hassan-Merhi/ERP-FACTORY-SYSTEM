import { useEffect, useRef } from "react";

const POLL_INTERVAL_MS = 8_000;

export function useServerRestart() {
  const knownBootId = useRef<string | null>(null);
  const reloading = useRef(false);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    let timer: ReturnType<typeof setTimeout>;

    async function check() {
      if (reloading.current) return;
      try {
        const res = await fetch("/api/boot", { credentials: "omit" });
        // A non-OK answer (e.g. 503 while the dev server is still starting) means
        // "not ready yet", like a network error: poll again rather than stop for good.
        if (res.ok) {
          const { bootId } = await res.json();
          if (knownBootId.current === null) {
            knownBootId.current = bootId;
          } else if (knownBootId.current !== bootId) {
            reloading.current = true;
            window.location.reload();
            return;
          }
        }
      } catch {
        // server not yet ready — try again next tick
      }
      timer = setTimeout(check, POLL_INTERVAL_MS);
    }

    timer = setTimeout(check, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, []);
}
