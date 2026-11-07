/**
 * Phase 2: globally mounted, non-interactive Christmas snowfall.
 *
 * One canvas avoids dozens of DOM nodes, CSS animations and re-mounts on
 * ordinary page navigation. It is intentionally separate from login (Phase 4).
 */
import { useEffect, useRef } from "react";
import { useSeasonalMotionRestricted } from "@/hooks/useSeasonalMotionRestricted";
import { useTheme } from "@/components/ThemeProvider";

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

function SnowfallCanvas({ intensity }: { intensity: "subtle" | "balanced" | "full" }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return;

    const ctx = context;
    const element = canvas;
    const color = theme === "dark" ? "#e9f6ff" : "#578bac";
    let width = 0;
    let height = 0;
    const flakes: Flake[] = [];
    let frameId: number | null = null;
    let resizeFrameId: number | null = null;
    let lastDraw = 0;
    let destroyed = false;
    let printPaused = false;

    function resizeCanvas() {
      const nextWidth = Math.max(1, window.innerWidth);
      const nextHeight = Math.max(1, window.innerHeight);
      const previousWidth = width;
      const previousHeight = height;
      width = nextWidth;
      height = nextHeight;

      // Keep the backing store under ~3 million pixels even on 4K/HiDPI screens.
      // A low-resolution transparent particle layer is fine; a 33MP canvas isn't.
      const deviceRatio = Math.min(window.devicePixelRatio || 1, width < 640 ? 1.5 : 1.75);
      const areaRatio = Math.sqrt(3_000_000 / (width * height));
      const pixelRatio = Math.min(deviceRatio, areaRatio);
      element.width = Math.max(1, Math.round(width * pixelRatio));
      element.height = Math.max(1, Math.round(height * pixelRatio));
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      if (previousWidth && previousHeight) {
        for (const flake of flakes) {
          flake.x = (flake.x / previousWidth) * width;
          flake.y = (flake.y / previousHeight) * height;
        }
      }

      const baseCount = snowfallParticleCount(width, height);
      const maxCount = width < 640 ? 24 : 64;
      const desiredCount = Math.min(
        maxCount,
        Math.round(baseCount * (intensity === "subtle" ? 0.5 : intensity === "full" ? 1.35 : 1))
      );
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
      if (destroyed || document.hidden || printPaused || frameId !== null) return;
      frameId = window.requestAnimationFrame(render);
    }

    function onVisibilityChange() {
      if (document.hidden) stop();
      else resume();
    }

    function scheduleResize() {
      // Mobile keyboards and fold/rotation changes can dispatch many resize
      // events in one frame. Recreate the canvas backing store only once.
      if (resizeFrameId !== null) return;
      resizeFrameId = window.requestAnimationFrame(() => {
        resizeFrameId = null;
        if (!destroyed) resizeCanvas();
      });
    }

    function onBeforePrint() {
      printPaused = true;
      stop();
      ctx.clearRect(0, 0, width, height);
    }

    function onAfterPrint() {
      printPaused = false;
      resume();
    }

    resizeCanvas();
    window.addEventListener("resize", scheduleResize, { passive: true });
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", resume);
    resume();

    return () => {
      destroyed = true;
      stop();
      window.removeEventListener("resize", scheduleResize);
      if (resizeFrameId !== null) window.cancelAnimationFrame(resizeFrameId);
      resizeFrameId = null;
      window.removeEventListener("beforeprint", onBeforePrint);
      window.removeEventListener("afterprint", onAfterPrint);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("pageshow", resume);
      ctx.clearRect(0, 0, width, height);
    };
  }, [theme, intensity]);

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
export function GlobalSnowfall({
  enabled,
  intensity = "balanced",
}: {
  enabled: boolean;
  intensity?: "subtle" | "balanced" | "full";
}) {
  const motionRestricted = useSeasonalMotionRestricted();
  if (!enabled || motionRestricted) return null;
  return <SnowfallCanvas intensity={intensity} />;
}
