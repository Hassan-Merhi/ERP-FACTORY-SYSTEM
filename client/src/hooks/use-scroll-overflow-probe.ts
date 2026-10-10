import { useEffect, type RefObject } from "react";

export const SCROLL_OVERFLOW_SELECTOR = '.erp-mobile-scroll-tabs, [data-responsive-tabs="true"]';
const ATTR = "data-scroll-overflow";

export type ScrollOverflowState = "none" | "start" | "end" | "both";

/** Which edges of a sideways scroller still hide content. */
export function readScrollOverflow(el: HTMLElement): ScrollOverflowState {
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 1) return "none";
  // RTL scrollLeft is negative in modern browsers; use the magnitude.
  const pos = Math.abs(el.scrollLeft);
  const atStart = pos <= 1;
  const atEnd = pos >= max - 1;
  if (atStart && atEnd) return "none";
  if (atStart) return "end";
  if (atEnd) return "start";
  return "both";
}

function update(el: HTMLElement) {
  const next = readScrollOverflow(el);
  if (el.getAttribute(ATTR) !== next) el.setAttribute(ATTR, next);
}

/**
 * Marks sideways-scrolling tab strips inside `rootRef` with `data-scroll-overflow`
 * ("none" | "start" | "end" | "both") so CSS can fade the edge that still hides tabs. One
 * capture-phase scroll listener and one ResizeObserver cover every strip, including strips
 * mounted later (MutationObserver). Nothing is rendered; it only toggles the attribute.
 */
export function useScrollOverflowProbe(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;

    const tracked = new Set<HTMLElement>();
    const resize = new ResizeObserver((entries) => {
      for (const entry of entries) update(entry.target as HTMLElement);
    });

    const track = (el: HTMLElement) => {
      if (tracked.has(el)) return;
      tracked.add(el);
      resize.observe(el);
      update(el);
    };
    const scan = () => {
      root.querySelectorAll<HTMLElement>(SCROLL_OVERFLOW_SELECTOR).forEach(track);
      for (const el of tracked) {
        if (!el.isConnected) {
          resize.unobserve(el);
          tracked.delete(el);
        }
      }
    };

    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && tracked.has(target)) update(target);
    };

    scan();
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const mutations = new MutationObserver(() => scan());
    mutations.observe(root, { childList: true, subtree: true });

    return () => {
      root.removeEventListener("scroll", onScroll, { capture: true });
      mutations.disconnect();
      resize.disconnect();
      for (const el of tracked) el.removeAttribute(ATTR);
      tracked.clear();
    };
  }, [rootRef]);
}
