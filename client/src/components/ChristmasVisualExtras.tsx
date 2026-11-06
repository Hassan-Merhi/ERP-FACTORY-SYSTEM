/**
 * Christmas 2.0 extras: small, non-blocking ornaments over authenticated shells.
 * Every effect is gated by Developer settings and the caller's personal opt-in.
 * No transactions, business state, network calls, or external image assets.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Flame, Gift, Minus, Sparkles, Star, TreePine } from "lucide-react";
import type { ChristmasIntensity } from "@/hooks/useChristmasMode";
import { useSeasonalMotionRestricted } from "@/hooks/useSeasonalMotionRestricted";
import "@/styles/christmas-visual-extras.css";

const TOP_BAR_SELECTOR = '[data-slot="app-top-bar"], [data-slot="pos-top-bar"]';

function useVisibleTopBar(active: boolean) {
  const [header, setHeader] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) {
      setHeader(null);
      return;
    }
    const find = () => {
      const next =
        Array.from(document.querySelectorAll<HTMLElement>(TOP_BAR_SELECTOR)).find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 120 && rect.height > 24;
        }) ?? null;
      setHeader((previous) => (previous === next ? previous : next));
    };
    find();
    const timer = window.setInterval(find, 1600);
    return () => window.clearInterval(timer);
  }, [active]);
  return header;
}

/** Local-calendar countdown; UTC day numbers avoid daylight-saving errors. */
export function daysUntilChristmas(now: Date): number {
  const currentYear = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const year = month === 11 && day > 25 ? currentYear + 1 : currentYear;
  const currentDay = Date.UTC(currentYear, month, day);
  return Math.max(0, Math.round((Date.UTC(year, 11, 25) - currentDay) / 86_400_000));
}

function ChristmasCountdown() {
  const header = useVisibleTopBar(true);
  const [days, setDays] = useState(() => daysUntilChristmas(new Date()));

  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) setDays(daysUntilChristmas(new Date()));
    };
    refresh();
    const interval = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  if (!header) return null;
  const message = days === 0 ? "Merry Christmas!" : `${days} day${days === 1 ? "" : "s"} to Christmas`;
  return createPortal(
    <span className="christmas-countdown-chip" aria-label={message} data-testid="christmas-countdown">
      <CalendarDays aria-hidden="true" />
      <span>{message}</span>
    </span>,
    header
  );
}

/** Occasional low-stakes greeting: never changes the ERP or any user records. */
function ChristmasSurpriseGift({ intensity }: { intensity: ChristmasIntensity }) {
  const motionRestricted = useSeasonalMotionRestricted();
  const [visible, setVisible] = useState(false);
  const [greeting, setGreeting] = useState(false);

  useEffect(() => {
    if (motionRestricted) {
      setVisible(false);
      setGreeting(false);
      return;
    }
    const frequency = intensity === "full" ? 7 * 60_000 : intensity === "subtle" ? 20 * 60_000 : 12 * 60_000;
    let timer: number | undefined;
    let hideTimer: number | undefined;
    let first = true;

    const show = () => {
      if (document.hidden) return;
      setVisible(true);
      if (hideTimer !== undefined) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setVisible(false), 19_000);
    };
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          first = false;
          show();
          schedule();
        },
        first ? (intensity === "full" ? 30_000 : intensity === "subtle" ? 120_000 : 75_000) : frequency
      );
    };
    const hideWhenBackgrounded = () => {
      if (document.hidden) setVisible(false);
    };
    const preview = () => show();
    schedule();
    document.addEventListener("visibilitychange", hideWhenBackgrounded);
    window.addEventListener("christmas:gift-preview", preview);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      if (hideTimer !== undefined) window.clearTimeout(hideTimer);
      document.removeEventListener("visibilitychange", hideWhenBackgrounded);
      window.removeEventListener("christmas:gift-preview", preview);
    };
  }, [intensity, motionRestricted]);

  useEffect(() => {
    if (!greeting) return;
    const timer = window.setTimeout(() => setGreeting(false), 4_500);
    return () => window.clearTimeout(timer);
  }, [greeting]);

  if (motionRestricted) return null;

  return (
    <>
      {visible && (
        <button
          type="button"
          className="christmas-gift-surprise"
          aria-label="Open a Christmas surprise"
          data-testid="christmas-surprise-gift"
          onClick={() => {
            setVisible(false);
            setGreeting(true);
          }}
        >
          <Gift aria-hidden="true" />
          <Sparkles className="christmas-gift-sparkle" aria-hidden="true" />
        </button>
      )}
      {greeting && (
        <div className="christmas-gift-message" role="status" data-testid="christmas-gift-greeting">
          <Star aria-hidden="true" />
          <span>Wishing you a wonderful Christmas season!</span>
        </div>
      )}
    </>
  );
}

function ChristmasAmbientCorner() {
  const [minimized, setMinimized] = useState(false);
  return (
    <aside
      className={`christmas-ambient-corner${minimized ? " christmas-ambient-minimized" : ""}`}
      aria-label="Christmas ambient corner"
      data-testid="christmas-ambient-corner"
    >
      <button
        type="button"
        className="christmas-ambient-control"
        aria-label={minimized ? "Show Christmas corner" : "Minimize Christmas corner"}
        title={minimized ? "Show Christmas corner" : "Minimize Christmas corner"}
        onClick={() => setMinimized((previous) => !previous)}
      >
        {minimized ? <TreePine aria-hidden="true" /> : <Minus aria-hidden="true" />}
      </button>
      {!minimized && (
        <div className="christmas-ambient-art" aria-hidden="true">
          <div className="christmas-ambient-tree">
            <Star className="christmas-ambient-star" />
            <TreePine className="christmas-ambient-pine" />
            <span className="christmas-tree-bauble christmas-bauble-a" />
            <span className="christmas-tree-bauble christmas-bauble-b" />
            <span className="christmas-tree-bauble christmas-bauble-c" />
          </div>
          <div className="christmas-fireplace">
            <span className="christmas-fireplace-mantel" />
            <Flame aria-hidden="true" />
          </div>
          <div className="christmas-ambient-ground" />
        </div>
      )}
    </aside>
  );
}

export function ChristmasVisualExtras({
  enabled,
  countdown,
  gifts,
  ambient,
  intensity,
}: {
  enabled: boolean;
  countdown: boolean;
  gifts: boolean;
  ambient: boolean;
  intensity: ChristmasIntensity;
}) {
  if (!enabled) return null;
  return (
    <>
      {countdown && <ChristmasCountdown />}
      {gifts && <ChristmasSurpriseGift intensity={intensity} />}
      {ambient && <ChristmasAmbientCorner />}
    </>
  );
}
