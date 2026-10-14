import { isRecord } from "@shared/typeGuards";

type ErpHistoryMeta = {
  version: 1;
  mode: "erp";
  from: string | null;
  entryUrl: string;
  scrollTop: number;
};

const ERP_HISTORY_STATE_KEY = "__erpNavigation";
const ERP_BACK_CONTROL_SELECTOR =
  '[data-testid="button-back"], [data-testid^="button-back-to-"], [data-testid^="button-"][data-testid$="-back"]';

let installCount = 0;
let originalPushState: History["pushState"] | null = null;
let originalReplaceState: History["replaceState"] | null = null;
let pendingScrollRestore: number | null = null;
let popstateHandler: ((event: PopStateEvent) => void) | null = null;
let legacyBackClickHandler: ((event: MouseEvent) => void) | null = null;

function currentRelativeUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function resolveRelativeUrl(url?: string | URL | null): string {
  if (url === undefined || url === null) return currentRelativeUrl();
  const resolved = new URL(String(url), window.location.href);
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function readMeta(state: unknown = window.history.state): ErpHistoryMeta | null {
  if (!isRecord(state)) return null;
  const candidate = state[ERP_HISTORY_STATE_KEY];
  if (!isRecord(candidate)) return null;
  if (candidate.version !== 1 || candidate.mode !== "erp") return null;
  if (typeof candidate.entryUrl !== "string") return null;
  if (candidate.from !== null && typeof candidate.from !== "string") return null;
  if (typeof candidate.scrollTop !== "number" || !Number.isFinite(candidate.scrollTop)) return null;
  return candidate as ErpHistoryMeta;
}

function withMeta(state: unknown, meta: ErpHistoryMeta): Record<string, unknown> {
  return {
    ...(isRecord(state) ? state : {}),
    [ERP_HISTORY_STATE_KEY]: meta,
  };
}

function getMainScrollTop(): number {
  const main = document.getElementById("main-content");
  return main instanceof HTMLElement ? main.scrollTop : 0;
}

function isCurrentErpPath(): boolean {
  const path = window.location.pathname;
  return !path.startsWith("/factory") && !path.startsWith("/properties");
}

function persistCurrentEntryScroll(): void {
  if (!originalReplaceState || typeof window === "undefined") return;

  const existing = readMeta();
  const entryUrl = currentRelativeUrl();
  const meta: ErpHistoryMeta = {
    version: 1,
    mode: "erp",
    from: existing?.from ?? null,
    entryUrl,
    scrollTop: getMainScrollTop(),
  };

  originalReplaceState(withMeta(window.history.state, meta), "", entryUrl);
}

function markCurrentEntry(): void {
  if (!originalReplaceState || typeof window === "undefined") return;

  const existing = readMeta();
  const entryUrl = currentRelativeUrl();
  const meta: ErpHistoryMeta = {
    version: 1,
    mode: "erp",
    from: existing?.from ?? null,
    entryUrl,
    scrollTop: existing?.scrollTop ?? getMainScrollTop(),
  };

  originalReplaceState(withMeta(window.history.state, meta), "", entryUrl);
}

/**
 * Installs an ERP-only History API tracker while the ERP shell is mounted.
 *
 * Every SPA push records the exact originating ERP URL (including query/hash)
 * on the newly-created history entry. Before leaving a page we also persist
 * the main workspace scroll position on the current entry. This lets shared
 * Back controls use the browser history entry first, while deterministic
 * parent-route mappings remain available as a deep-link/refresh fallback.
 *
 * A capture listener also covers older ERP pages that render their own Back
 * button instead of using PageHeader/useBackToParent. When a tracked previous
 * ERP entry exists, those controls are upgraded to the same exact-history
 * behavior without relying on every individual page to be patched forever.
 */
export function installErpNavigationHistory(): () => void {
  if (typeof window === "undefined") return () => {};

  installCount += 1;
  if (installCount > 1) {
    markCurrentEntry();
    return () => {
      installCount = Math.max(0, installCount - 1);
    };
  }

  originalPushState = window.history.pushState.bind(window.history);
  originalReplaceState = window.history.replaceState.bind(window.history);
  markCurrentEntry();

  window.history.pushState = (data, unused: string, url?: string | URL | null) => {
    const from = currentRelativeUrl();
    persistCurrentEntryScroll();

    const entryUrl = resolveRelativeUrl(url);
    const meta: ErpHistoryMeta = {
      version: 1,
      mode: "erp",
      from,
      entryUrl,
      scrollTop: 0,
    };

    originalPushState?.(withMeta(data, meta), unused, url);
  };

  window.history.replaceState = (data, unused: string, url?: string | URL | null) => {
    const existing = readMeta();
    const entryUrl = resolveRelativeUrl(url);
    const meta: ErpHistoryMeta = {
      version: 1,
      mode: "erp",
      from: existing?.from ?? null,
      entryUrl,
      scrollTop: getMainScrollTop(),
    };

    originalReplaceState?.(withMeta(data, meta), unused, url);
  };

  popstateHandler = (event: PopStateEvent) => {
    const meta = readMeta(event.state);
    pendingScrollRestore = meta?.mode === "erp" && isCurrentErpPath() ? Math.max(0, meta.scrollTop) : null;
  };
  window.addEventListener("popstate", popstateHandler);

  legacyBackClickHandler = (event: MouseEvent) => {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const backControl = target.closest(ERP_BACK_CONTROL_SELECTOR);
    if (!backControl || !canGoBackToPreviousErpLocation()) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    goBackToPreviousErpLocation();
  };
  window.addEventListener("click", legacyBackClickHandler, true);

  return () => {
    installCount = Math.max(0, installCount - 1);
    if (installCount > 0) return;

    if (popstateHandler) {
      window.removeEventListener("popstate", popstateHandler);
      popstateHandler = null;
    }
    if (legacyBackClickHandler) {
      window.removeEventListener("click", legacyBackClickHandler, true);
      legacyBackClickHandler = null;
    }
    if (originalPushState) window.history.pushState = originalPushState;
    if (originalReplaceState) window.history.replaceState = originalReplaceState;

    originalPushState = null;
    originalReplaceState = null;
    pendingScrollRestore = null;
  };
}

/** True when the current ERP history entry was pushed from another ERP URL. */
export function canGoBackToPreviousErpLocation(): boolean {
  if (typeof window === "undefined" || !isCurrentErpPath()) return false;
  const meta = readMeta();
  return !!meta?.from && meta.entryUrl === currentRelativeUrl() && window.history.length > 1;
}

/**
 * Goes back to the exact prior ERP history entry when one is known.
 * Returns false when the page was opened directly/refreshed, allowing callers
 * to use the deterministic parent-route registry as a safe fallback.
 */
export function goBackToPreviousErpLocation(): boolean {
  if (!canGoBackToPreviousErpLocation()) return false;
  persistCurrentEntryScroll();
  window.history.back();
  return true;
}

/** Returns a one-shot scroll position captured for an ERP browser Back/Forward navigation. */
export function consumeErpScrollRestore(): number | null {
  const value = pendingScrollRestore;
  pendingScrollRestore = null;
  return value;
}
