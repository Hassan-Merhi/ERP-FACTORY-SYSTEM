/**
 * Phase 2: globally mounted, non-interactive Christmas snowfall.
 *
 * One canvas avoids dozens of DOM nodes, CSS animations and re-mounts on
 * ordinary page navigation. It is intentionally separate from login (Phase 4).
 */
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/ThemeProvider";
import { useChristmasMode } from "@/hooks/useChristmasMode";

type Flake = {
  x: number;
  y: number;
  size: number;
  fallSpeed: number;
  driftSpeed: number;
  swing: number;
  swingSpeed: number;
  opacity: number;
  crystal: boolean;
};

const MAX_DESKTOP_FLAKES = 64;
const MAX_MOBILE_FLAKES = 24;

export function snowfallParticleCount(width: number, height: number): number {
  const mobile = width < 640;
  const density = Math.round((Math.max(1, width) * Math.max(1, height)) / (mobile ? 21000 : 24000));
  return Math.min(mobile ? MAX_MOBILE_FLAKES : MAX_DESKTOP_FLAKES, Math.max(mobile ? 12 : 24, density));
}

function randomFlake(width: number, height: number, startAbove = false): Flake {
  const size = 0.85 + Math.random() * 2.25;
  return {
    x: Math.random() * width,
    y: startAbove ? -Math.random() * 45 : Math.random() * height,
    size,
    fallSpeed: 13 + Math.random() * 28,
    driftSpeed: -7 + Math.random() * 14,
    swing: Math.random() * Math.PI * 2,
    swingSpeed: 0.55 + Math.random() * 0.85,
    opacity: 0.32 + Math.random() * 0.46,
    crystal: Math.random() < 0.24,
  };
}

function SnowfallCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return;

    const ctx = context;
    const color = theme === "dark" ? "#e9f6ff" : "#578bac";
    let width = 0;
    let height = 0;
    let flakes: Flake[] = [];
    let frameId: number | null = null;
    let lastDraw = 0;
    let destroyed = false;

    function resizeCanvas() {
      const nextWidth = Math.max(1, window.innerWidth);
      const nextHeight = Math.max(1, window.innerHeight);
      const previousWidth = width;
      const previousHeight = height;
      width = nextWidth;
      height = nextHeight;

      // Cap high-density canvas backing pixels, especially on phones.
      const pixelRatio = Math.min(window.devicePixelRatio || 1, width < 640 ? 1.5 : 2);
      canvas!.width = Math.round(width * pixelRatio);
      canvas!.height = Math.round(height * pixelRatio);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      if (previousWidth && previousHeight) {
        for (const flake of flakes) {
          flake.x = (flake.x / previousWidth) * width;
          flake.y = (flake.y / previousHeight) * height;
        }
      }

      const desiredCount = snowfallParticleCount(width, height);
      if (flakes.length > desiredCount) flakes.length = desiredCount;
      while (flakes.length < desiredCount) flakes.push(randomFlake(width, height));
    }

    function paintFlake(flake: Flake) {
      ctx.globalAlpha = flake.opacity;
      if (flake.crystal) {
        // A few six-point snow crystals between the smaller soft flakes.
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(0.7, flake.size * 0.35);
        ctx.beginPath();
        for (let arm = 0; arm < 3; arm++) {
          const angle = (arm * Math.PI) / 3;
          const dx = Math.cos(angle) * flake.size * 1.65;
          const dy = Math.sin(angle) * flake.size * 1.65;
          ctx.moveTo(flake.x - dx, flake.y - dy);
          ctx.lineTo(flake.x + dx, flake.y + dy);
        }
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(flake.x, flake.y, flake.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function render(now: number) {
      frameId = null;
      if (destroyed || document.hidden) return;

      const mobile = width < 640;
      const minFrameMs = mobile ? 1000 / 24 : 1000 / 30;
      const elapsed = lastDraw ? now - lastDraw : minFrameMs;
      if (elapsed >= minFrameMs) {
        const seconds = Math.min(elapsed / 1000, 0.08);
        lastDraw = now;
        ctx.clearRect(0, 0, width, height);
        for (let i = 0; i < flakes.length; i++) {
          const flake = flakes[i];
          flake.swing += flake.swingSpeed * seconds;
          flake.x += (flake.driftSpeed + Math.sin(flake.swing) * 7) * seconds;
          flake.y += flake.fallSpeed * seconds;
          if (flake.y > height + 8 || flake.x < -18 || flake.x > width + 18) {
            flakes[i] = randomFlake(width, height, true);
          } else {
            paintFlake(flake);
          }
        }
        ctx.globalAlpha = 1;
      }
      frameId = window.requestAnimationFrame(render);
    }

    function stop() {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = null;
      lastDraw = 0;
    }

    function resume() {
      if (destroyed || document.hidden || frameId !== null) return;
      frameId = window.requestAnimationFrame(render);
    }

    function onVisibilityChange() {
      if (document.hidden) stop();
      else resume();
    }

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", resume);
    resume();

    return () => {
      destroyed = true;
      stop();
      window.removeEventListener("resize", resizeCanvas);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("pageshow", resume);
      ctx.clearRect(0, 0, width, height);
    };
  }, [theme]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="global-christmas-snowfall"
      data-global-snowfall="true"
      aria-hidden="true"
      role="presentation"
      className="pointer-events-none fixed inset-0 z-[35] block select-none print:hidden"
      style={{ pointerEvents: "none" }}
    />
  );
}

/**
 * Only render after the global setting is explicitly ON.
 * Reduced-motion users never start the canvas animation.
 */
export function GlobalSnowfall() {
  const { settingQuery } = useChristmasMode();
  const [reduceMotion, setReduceMotion] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (event: MediaQueryListEvent) => setReduceMotion(event.matches);
    setReduceMotion(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  if (settingQuery.data?.enabled !== true || reduceMotion) return null;
  return <SnowfallCanvas />;
}
