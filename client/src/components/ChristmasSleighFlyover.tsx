/**
 * A lightweight flyover in the shared ERP/POS top bar every five visible minutes.
 * Does not capture clicks, run while hidden, or run during camera scanning.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useSeasonalMotionRestricted } from "@/hooks/useSeasonalMotionRestricted";
import "@/styles/christmas-sleigh.css";

const FLIGHT_INTERVAL_MS = 5 * 60 * 1000;
const FLIGHT_DURATION_MS = 11_000;
const TOP_BAR_SELECTOR = '[data-slot="app-top-bar"], [data-slot="pos-top-bar"]';

function SleighArtwork() {
  return (
    <svg viewBox="0 0 390 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="christmas-sleigh-red" x1="0" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#ff7670" />
          <stop offset="0.48" stopColor="#c82d42" />
          <stop offset="1" stopColor="#8b182c" />
        </linearGradient>
        <linearGradient id="christmas-sleigh-gold" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffe2a3" />
          <stop offset="0.55" stopColor="#eac167" />
          <stop offset="1" stopColor="#c08c39" />
        </linearGradient>
      </defs>
      {/* A short trail of magical glints from the sleigh. */}
      <g fill="#ffe6aa" opacity="0.9">
        <path d="M356 41l2.1 5.3 5.3 2.1-5.3 2.1-2.1 5.3-2.1-5.3-5.3-2.1 5.3-2.1z" />
        <circle cx="377" cy="36" r="2.1" />
        <circle cx="369" cy="63" r="1.7" />
        <path d="M384 53v8m-4-4h8" stroke="#f4dfba" strokeWidth="1.6" />
      </g>
      {/* The leading pair fly to the left, joined by warm gold reins. */}
      <path d="M102 51Q165 58 221 56M45 48Q125 65 221 58" stroke="#eccd8d" strokeWidth="1.6" fill="none" opacity="0.83" />
      {[{ x: 17, y: 25, scale: 0.85 }, { x: 99, y: 19, scale: 0.91 }].map((deer) => (
        <g key={deer.x} transform={`translate(${deer.x} ${deer.y}) scale(${deer.scale})`}>
          <path d="M44 28Q52 14 69 16Q80 20 76 28" fill="none" stroke="#9d6442" strokeWidth="9" strokeLinecap="round" />
          <ellipse cx="39" cy="36" rx="25" ry="12" fill="#bb8055" />
          <path d="M22 41L11 65M48 43L55 66M52 32L67 55M26 30L20 12" fill="none" stroke="#91603e" strokeWidth="5" strokeLinecap="round" />
          <path d="M6 65l9 3m38-2 9 2m4-13 8 2M15 13l6 3" stroke="#5b3d36" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M71 19L78 -1M73 12L64 -2M76 6L89 -3M62 18L61 0" stroke="#b77d50" strokeWidth="3.4" fill="none" strokeLinecap="round" />
          <ellipse cx="76" cy="24" rx="11" ry="8" fill="#c58d60" />
          <circle cx="80" cy="22" r="1.8" fill="#332324" />
          <circle cx="86" cy="28" r="3.5" fill="#ee615c" />
          <path d="M25 28Q46 39 66 30" fill="none" stroke="#f0d3a0" strokeWidth="2" opacity="0.75" />
        </g>
      ))}
      {/* A curved sleigh runner and warm wooden undercarriage. */}
      <path d="M223 75Q267 83 324 76Q341 75 343 67" fill="none" stroke="#bb8e42" strokeWidth="6" strokeLinecap="round" />
      <path d="M219 73Q265 81 325 73Q341 72 343 64" fill="none" stroke="url(#christmas-sleigh-gold)" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M232 68V75M315 65V73" stroke="#d7a552" strokeWidth="5" strokeLinecap="round" />
      {/* The sleigh body has a high curved front, thin gold piping and gifts. */}
      <path d="M220 48Q235 59 246 56L299 52Q316 52 320 35L329 33Q337 59 323 67Q305 76 249 70Q225 68 220 48Z" fill="url(#christmas-sleigh-red)" stroke="#e9bb7b" strokeWidth="2.8" />
      <path d="M230 52Q252 63 299 59" fill="none" stroke="#ffe6bd" strokeWidth="2.2" opacity="0.87" />
      <rect x="301" y="40" width="16" height="14" rx="2" fill="#2e9d77" />
      <path d="M309 40v14m-8-7h16" stroke="#f6d896" strokeWidth="2.4" />
      <rect x="222" y="32" width="22" height="21" rx="2" fill="#339e86" />
      <path d="M232 32v21m-10-11h22" stroke="#ffe5a4" strokeWidth="3" />
      {/* Santa's coat, face, beard and signature stocking cap. */}
      <path d="M256 31Q259 21 279 20Q293 22 296 38L302 54Q278 62 255 50Z" fill="#d33845" stroke="#8a1a29" strokeWidth="2.3" />
      <path d="M257 47Q276 54 300 49" fill="none" stroke="#f9f1e6" strokeWidth="5.5" />
      <path d="M281 27v26" stroke="#f9f0df" strokeWidth="5" />
      <rect x="278" y="39" width="7" height="8" rx="1.5" fill="#d7ad53" />
      <path d="M264 36Q247 40 244 48" fill="none" stroke="#c82b3a" strokeWidth="10" strokeLinecap="round" />
      <circle cx="242" cy="49" r="5.2" fill="#eee8dc" />
      <circle cx="278" cy="16" r="15" fill="#ffe0bd" />
      <path d="M264 18Q262 38 280 39Q297 36 292 18L284 24L276 20Z" fill="#fff3e5" />
      <path d="M264 13Q266 -2 279 -5Q297 -6 298 13Q310 7 315 0" fill="#c6283d" stroke="#fff0e0" strokeWidth="2" />
      <path d="M263 12Q280 8 299 13" stroke="#fdf6eb" strokeWidth="6" strokeLinecap="round" />
      <circle cx="315" cy="0" r="6" fill="#fff7eb" />
      <circle cx="273" cy="16" r="1.8" fill="#4d2d2b" />
      <circle cx="285" cy="16" r="1.8" fill="#4d2d2b" />
      <ellipse cx="279" cy="22" rx="3.5" ry="2.3" fill="#f19c94" />
      <path d="M274 27Q280 32 286 27" stroke="#b77b6c" strokeWidth="1.6" fill="none" />
      <path d="M292 37Q305 33 305 22" stroke="#d33845" strokeWidth="10" strokeLinecap="round" fill="none" />
      <circle cx="307" cy="20" r="5.5" fill="#f9f0e7" />
    </svg>
  );
}

export function ChristmasSleighFlyover({ enabled }: { enabled: boolean }) {
  const motionRestricted = useSeasonalMotionRestricted();
  const active = enabled && !motionRestricted;
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [headerWidth, setHeaderWidth] = useState(0);
  const [flying, setFlying] = useState(false);

  // Authenticated shells swap their header on workspace changes.
  useEffect(() => {
    if (!active) {
      setHeader(null);
      return;
    }
    const findHeader = () => {
      const next = document.querySelector<HTMLElement>(TOP_BAR_SELECTOR);
      setHeader((previous) => previous === next ? previous : next);
    };
    findHeader();
    const check = window.setInterval(findHeader, 1500);
    return () => window.clearInterval(check);
  }, [active]);

  useEffect(() => {
    if (!header || !active) return;
    const measure = () => setHeaderWidth(header.getBoundingClientRect().width);
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(header);
    window.addEventListener("resize", measure, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [header, active]);

  // Count only time spent in a visible tab. No animation is queued while hidden.
  useEffect(() => {
    setFlying(false);
    if (!active) return;
    let remaining = FLIGHT_INTERVAL_MS;
    let started = 0;
    let timer: number | undefined;
    let endFlight: number | undefined;

    const pause = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
        remaining = Math.max(0, remaining - (Date.now() - started));
      }
      if (endFlight !== undefined) {
        window.clearTimeout(endFlight);
        endFlight = undefined;
      }
      setFlying(false);
    };
    const schedule = () => {
      if (document.hidden) return;
      started = Date.now();
      timer = window.setTimeout(() => {
        timer = undefined;
        remaining = FLIGHT_INTERVAL_MS;
        setFlying(true);
        endFlight = window.setTimeout(() => {
          endFlight = undefined;
          setFlying(false);
        }, FLIGHT_DURATION_MS);
        schedule();
      }, remaining);
    };
    const visibility = () => {
      pause();
      if (!document.hidden) schedule();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pause);
    window.addEventListener("pageshow", visibility);
    schedule();
    return () => {
      pause();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pause);
      window.removeEventListener("pageshow", visibility);
    };
  }, [active]);

  if (!active || !header || !flying) return null;

  return createPortal(
    <div
      className="christmas-sleigh-flight"
      data-testid="christmas-sleigh-flyover"
      aria-hidden="true"
      style={{ "--santa-flight-distance": `${Math.max(headerWidth, 300) + 345}px` } as CSSProperties}
    >
      <SleighArtwork />
    </div>,
    header,
  );
}
