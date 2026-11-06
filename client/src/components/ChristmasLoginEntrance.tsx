/**
 * Phase 4: a four-second, non-blocking welcome after a genuine successful
 * sign-in. Refreshes and workspace navigation never trigger this animation.
 *
 * The Phase 2 snowfall continues underneath when the welcome finishes.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Snowflake, Sparkles, Volume2 } from "lucide-react";
import { consumeChristmasLoginEntrancePending } from "@/lib/christmasLoginEntrance";
import { useSeasonalMotionRestricted } from "@/hooks/useSeasonalMotionRestricted";
import { startChristmasJingle, CHRISTMAS_JINGLE_DURATION_MS } from "@/lib/christmasJingle";
import "@/styles/christmas-login-entrance.css";

const ENTRANCE_DURATION_MS = CHRISTMAS_JINGLE_DURATION_MS;

type Props = {
  enabled: boolean;
  queryStatus: "pending" | "success" | "error";
};

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
  const reduceMotion = useSeasonalMotionRestricted();
  const [visibleUntil, setVisibleUntil] = useState(0);
  const [needsTap, setNeedsTap] = useState(false);
  const playbackStopRef = useRef<(() => void) | null>(null);
  const playbackAttemptRef = useRef(0);

  const launchJingle = useCallback(() => {
    // Invalidate any older, unresolved playback attempts.
    const attempt = ++playbackAttemptRef.current;
    playbackStopRef.current?.();
    playbackStopRef.current = null;
    setNeedsTap(false);
    void startChristmasJingle().then((result) => {
      if (attempt !== playbackAttemptRef.current) {
        result.stop();
        return;
      }
      if (result.started) playbackStopRef.current = result.stop;
      else setNeedsTap(true);
    });
  }, []);


  // Consume only after the master setting has resolved. Even when OFF or when
  // the settings endpoint fails, consume and discard the hint so switching ON
  // later cannot replay a stale login welcome.
  useEffect(() => {
    if (queryStatus === "pending") return;
    const wasFreshLogin = consumeChristmasLoginEntrancePending();
    if (!wasFreshLogin || queryStatus !== "success" || !enabled || reduceMotion || document.hidden) return;
    setVisibleUntil(Date.now() + ENTRANCE_DURATION_MS);
    launchJingle();
  }, [queryStatus, enabled, reduceMotion, launchJingle]);

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
    if (!enabled || reduceMotion) {
      playbackAttemptRef.current += 1;
      playbackStopRef.current?.();
      playbackStopRef.current = null;
      setNeedsTap(false);
      setVisibleUntil(0);
    }
  }, [enabled, reduceMotion]);

  useEffect(() => () => {
    playbackAttemptRef.current += 1;
    playbackStopRef.current?.();
    playbackStopRef.current = null;
  }, []);


  if (!enabled || reduceMotion || visibleUntil === 0) return null;

  return (
    <div
      className="christmas-login-entrance pointer-events-none fixed inset-0 select-none print:hidden"
      data-testid="christmas-login-entrance"
      data-christmas-login-entrance="true"
      role="presentation"
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
      <div className="christmas-login-greeting" aria-hidden="true">
        <span className="christmas-login-greeting-icon">
          <Snowflake aria-hidden="true" />
        </span>
        <div className="christmas-login-greeting-copy">
          <span className="christmas-login-greeting-title">Merry Christmas</span>
          <span className="christmas-login-greeting-subtitle">Welcome back — wishing you a wonderful season</span>
        </div>
        <Sparkles className="christmas-login-greeting-sparkle" aria-hidden="true" />
      </div>
      {needsTap && (
        <button
          type="button"
          className="christmas-login-play-button"
          onClick={() => {
            setVisibleUntil(Date.now() + ENTRANCE_DURATION_MS);
            launchJingle();
          }}
          aria-label="Play the Christmas Jingle Bells greeting"
          data-testid="christmas-login-play-audio"
        >
          <Volume2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          Tap to hear Jingle Bells
        </button>
      )}
    </div>
  );
}
