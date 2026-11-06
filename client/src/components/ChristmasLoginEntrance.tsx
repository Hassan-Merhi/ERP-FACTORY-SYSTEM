/**
 * Phase 4: a four-second, non-blocking welcome after a genuine successful
 * sign-in. Refreshes and workspace navigation never trigger this animation.
 *
 * The Phase 2 snowfall continues underneath when the welcome finishes.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Snowflake, Sparkles } from "lucide-react";
import { consumeChristmasLoginEntrancePending } from "@/lib/christmasLoginEntrance";
import "@/styles/christmas-login-entrance.css";

const ENTRANCE_DURATION_MS = 4_000;

type Props = {
  enabled: boolean;
  queryStatus: "pending" | "success" | "error";
};

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    setReducedMotion(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return reducedMotion;
}

type FallStyle = CSSProperties & { "--welcome-drift": string };

// Stable, varied flakes without new random values during React rerenders.
// Mobile CSS caps visibility at the first 28 flakes.
const WELCOME_FLAKES: FallStyle[] = Array.from({ length: 56 }, (_, index) => {
  const fraction = (multiplier: number, offset: number) => ((index * multiplier + offset) % 97) / 97;
  return {
    left: `${fraction(43, 7) * 100}%`,
    fontSize: `${11 + fraction(23, 11) * 18}px`,
    opacity: 0.34 + fraction(31, 5) * 0.54,
    animationDelay: `${-fraction(17, 4) * 1.45}s`,
    animationDuration: `${3.3 + fraction(19, 9) * 1.7}s`,
    "--welcome-drift": `${Math.round((fraction(29, 1) - 0.5) * 125)}px`,
  };
});

export function ChristmasLoginEntrance({ enabled, queryStatus }: Props) {
  const reduceMotion = useReducedMotion();
  const [visibleUntil, setVisibleUntil] = useState(0);

  // Consume only after the master setting has resolved. Even when OFF or when
  // the settings endpoint fails, consume and discard the hint so switching ON
  // later cannot replay a stale login welcome.
  useEffect(() => {
    if (queryStatus === "pending") return;
    const wasFreshLogin = consumeChristmasLoginEntrancePending();
    if (!wasFreshLogin || queryStatus !== "success" || !enabled || reduceMotion || document.hidden) return;
    setVisibleUntil(Date.now() + ENTRANCE_DURATION_MS);
  }, [queryStatus, enabled, reduceMotion]);

  // Use a deadline rather than a timer tied to the first effect. This also
  // survives React Strict Mode's development effect setup/cleanup cycle.
  useEffect(() => {
    if (!visibleUntil) return;
    const remaining = visibleUntil - Date.now();
    if (remaining <= 0) {
      setVisibleUntil(0);
      return;
    }
    const timer = window.setTimeout(() => setVisibleUntil(0), remaining);
    return () => window.clearTimeout(timer);
  }, [visibleUntil]);

  useEffect(() => {
    if (!enabled || reduceMotion) setVisibleUntil(0);
  }, [enabled, reduceMotion]);

  if (!enabled || reduceMotion || visibleUntil === 0) return null;

  return (
    <div
      className="christmas-login-entrance pointer-events-none fixed inset-0 select-none print:hidden"
      data-testid="christmas-login-entrance"
      data-christmas-login-entrance="true"
      role="presentation"
      aria-hidden="true"
    >
      <div className="christmas-login-snowfield" aria-hidden="true">
        {WELCOME_FLAKES.map((style, index) => (
          <span
            key={index}
            className="christmas-login-flake"
            style={style}
          >
            {index % 5 === 0 ? "✦" : "❄"}
          </span>
        ))}
      </div>
      <div className="christmas-login-greeting">
        <span className="christmas-login-greeting-icon">
          <Snowflake aria-hidden="true" />
        </span>
        <div className="christmas-login-greeting-copy">
          <span className="christmas-login-greeting-title">Welcome back</span>
          <span className="christmas-login-greeting-subtitle">Wishing you a wonderful holiday season</span>
        </div>
        <Sparkles className="christmas-login-greeting-sparkle" aria-hidden="true" />
      </div>
    </div>
  );
}
