import { clearRemoteEditableFocus, focusRemoteEditableElement } from "./remote-keyboard-control-policy";
import { isRegisteredRemoteControlAction } from "./remote-control-action-registry";

export type RemoteMouseCommandType = "pointer-move" | "click" | "scroll";
export type RemoteMouseExecutionStatus = "executed" | "blocked" | "ignored";

export interface RemoteMouseFrameViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  visualScale: number;
}

export interface RemoteMouseCommandView {
  id: string;
  sessionId: string;
  type: RemoteMouseCommandType;
  sequence: number;
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
  frameViewport?: RemoteMouseFrameViewport;
  createdAt?: string;
}

export interface RemoteMouseExecutionResult {
  status: RemoteMouseExecutionStatus;
  reason: string | null;
  clientX: number;
  clientY: number;
}

export interface RemoteMouseExecutionOptions {
  keyboardEnabled?: boolean;
}

const BLOCKED_SELECTOR = [
  "input",
  "textarea",
  "select",
  "option",
  "form :is(button,a[href],[role='button'],[role='link'],[role='menuitem']):not([data-remote-control-action]):not([data-remote-control-safe='true'])",
  "[contenteditable]:not([contenteditable='false'])",
  "[data-remote-control-blocked='true']",
  "[data-sensitive-action]",
  "[data-destructive]",
  "[data-screenfeed-ignore='true']",
  "[disabled]",
  "[aria-disabled='true']",
].join(",");

const CLICKABLE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='tab']",
  "[data-remote-control-safe='true']",
  "[data-remote-control-action]",
].join(",");

const DANGEROUS_TEXT = new RegExp(
  [
    "\\b(save|submit|create|add|delete|remove|archive|restore|approve|reject|post|reverse|offload|cancel|pay|payment|receipt|transfer|send|print|whatsapp|logout|confirm|finalize|complete|import|upload|export|adjust|edit|password|permission)\\b",
    "sign[\\s_-]*out",
    "close[\\s_-]*period",
    "(?:^|[/\\s_-])new(?:[/\\s_-]|$)",
    "\\b(supprimer|enregistrer|confirmer|annuler|envoyer|payer|valider|modifier|ajouter|créer)\\b",
    "تأكيد",
    "حفظ",
    "حذف",
    "إضافة",
    "إرسال",
    "دفع",
    "تعديل",
    "إلغاء",
  ].join("|"),
  "i"
);

const SAFE_ACTION_TEXT = new RegExp(
  [
    "view",
    "open",
    "close",
    "back",
    "next",
    "previous",
    "details",
    "history",
    "show",
    "hide",
    "expand",
    "collapse",
    "search",
    "filter",
    "refresh",
    "clear filter",
    "fit",
    "full screen",
    "home",
    "dashboard",
    "menu",
    "navigation",
    "voir",
    "ouvrir",
    "fermer",
    "retour",
    "suivant",
    "précédent",
    "détails",
    "historique",
    "afficher",
    "masquer",
    "rechercher",
    "filtrer",
    "actualiser",
    "tableau de bord",
    "عرض",
    "فتح",
    "إغلاق",
    "رجوع",
    "التالي",
    "السابق",
    "تفاصيل",
    "السجل",
    "إظهار",
    "إخفاء",
    "بحث",
    "تصفية",
    "تحديث",
    "لوحة التحكم",
  ].join("|"),
  "i"
);

function finiteCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

// prettier-ignore
function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// prettier-ignore
function finiteOffset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function elementDescriptor(element: Element): string {
  const htmlElement = element as HTMLElement;
  const href = element instanceof HTMLAnchorElement ? (element.getAttribute("href") ?? "") : "";
  return [
    htmlElement.innerText,
    htmlElement.textContent,
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-testid"),
    element.getAttribute("name"),
    href,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSameOriginNavigation(anchor: HTMLAnchorElement, location: Location): boolean {
  const href = anchor.getAttribute("href")?.trim() ?? "";
  if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) return false;
  if (anchor.hasAttribute("download") || anchor.target === "_blank") return false;

  try {
    const target = new URL(href, location.href);
    return target.origin === location.origin;
  } catch {
    return false;
  }
}

export interface RemoteMouseFrameSize {
  width: number;
  height: number;
}

/**
 * The box the frame's pixels actually occupy inside the image element.
 * Viewers letterbox the frame with `object-fit: contain` whenever the
 * element's aspect ratio differs from the frame's, and coordinates taken
 * against the raw element rect would land offset. The frame size comes from
 * the image's natural (encoded) dimensions, or from the frame viewport
 * snapshot stamped on the image.
 */
export function getRemoteMouseFrameContentBox(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  frameSize: RemoteMouseFrameSize
): Pick<DOMRect, "left" | "top" | "width" | "height"> | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (!Number.isFinite(frameSize.width) || frameSize.width <= 0) return null;
  if (!Number.isFinite(frameSize.height) || frameSize.height <= 0) return null;
  const scale = Math.min(rect.width / frameSize.width, rect.height / frameSize.height);
  const width = frameSize.width * scale;
  const height = frameSize.height * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  };
}

export function normalizeRemoteMousePoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  frameSize?: RemoteMouseFrameSize | null
): { x: number; y: number } | null {
  const box = frameSize ? getRemoteMouseFrameContentBox(rect, frameSize) : rect;
  if (!box || box.width <= 0 || box.height <= 0) return null;
  const x = (clientX - box.left) / box.width;
  const y = (clientY - box.top) / box.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/**
 * Control accuracy — one coordinate space.
 *
 * Every mouse coordinate in the remote-control pipeline is normalized `0..1`
 * over exactly one region: the layout viewport the screen-feed capture engine
 * photographs (`window.innerWidth × window.innerHeight` showing document
 * content at `scrollX/scrollY`). The controller normalizes pointer input into
 * that frame space; the target maps it back out through the same space.
 *
 * `window.visualViewport` deliberately does NOT define the space: the frame is
 * captured from the layout viewport, and mapping through a different viewport
 * (pinch-zoomed or offset) lands clicks away from where the controller aimed.
 *
 * When the live viewport has drifted from the captured frame (the employee —
 * or an earlier remote command — scrolled, resized, or zoomed), the point is
 * REMAPPED through document space instead of rejecting the command: pure
 * scroll drift cancels exactly, so clicks keep landing on the content the
 * controller aimed at. Only a point that remaps outside the live viewport
 * (the aimed content is no longer visible) is ignored.
 *
 * Scroll commands are exempt from frame-viewport staleness entirely:
 * scrolling is precisely what invalidates the captured scroll position, so a
 * staleness gate would drop every scroll after the first. The scroll anchor
 * is still remapped so the right scroll container is chosen.
 */

export interface RemoteMouseViewportMetrics {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

/**
 * How far beyond the live viewport's edges a remapped frame point may sit and
 * still be treated as an in-view edge click. Absorbs the sub-pixel rounding
 * the server applies to frame snapshots; anything farther means the aimed
 * content really did scroll or reflow out of view.
 */
export const FRAME_POINT_EDGE_SLOP_PX = 2;

export function getRemoteMouseViewportMetrics(view: Window = window): RemoteMouseViewportMetrics {
  return {
    width: finitePositive(view.innerWidth, 1),
    height: finitePositive(view.innerHeight, 1),
    scrollX: finiteOffset(view.scrollX),
    scrollY: finiteOffset(view.scrollY),
  };
}

function coerceRemoteMouseFrameViewport(
  frame: RemoteMouseFrameViewport | null | undefined
): RemoteMouseFrameViewport | undefined {
  if (!frame) return undefined;
  if (
    !Number.isFinite(frame.width) ||
    frame.width <= 0 ||
    !Number.isFinite(frame.height) ||
    frame.height <= 0 ||
    !Number.isFinite(frame.scrollX) ||
    !Number.isFinite(frame.scrollY) ||
    !Number.isFinite(frame.visualScale) ||
    frame.visualScale <= 0
  ) {
    return undefined;
  }
  return frame;
}

export interface RemoteMouseFramePointMapping {
  clientX: number;
  clientY: number;
  /** False when the remapped frame point fell outside the live viewport. */
  onScreen: boolean;
}

/**
 * The single mapping every command type goes through: pointer display, click
 * hit testing, and scroll anchoring all land on the same pixel.
 *
 * - No usable snapshot (legacy controllers, pointer moves): the normalized
 *   point is already expressed against the live viewport.
 * - With a snapshot: the point is translated frame → document → live
 *   viewport, so viewport drift moves the point with the content instead of
 *   invalidating it.
 */
export function mapRemoteMouseFramePoint(
  x: number,
  y: number,
  frame: RemoteMouseFrameViewport | null | undefined,
  view: Window = window
): RemoteMouseFramePointMapping | null {
  if (!finiteCoordinate(x) || !finiteCoordinate(y)) return null;
  const live = getRemoteMouseViewportMetrics(view);
  const captured = coerceRemoteMouseFrameViewport(frame);

  if (!captured) {
    return {
      clientX: Math.max(0, Math.min(live.width - 1, x * live.width)),
      clientY: Math.max(0, Math.min(live.height - 1, y * live.height)),
      onScreen: true,
    };
  }

  const documentX = captured.scrollX + x * captured.width;
  const documentY = captured.scrollY + y * captured.height;
  const unclampedX = documentX - live.scrollX;
  const unclampedY = documentY - live.scrollY;
  return {
    clientX: Math.max(0, Math.min(live.width - 1, unclampedX)),
    clientY: Math.max(0, Math.min(live.height - 1, unclampedY)),
    onScreen:
      unclampedX >= -FRAME_POINT_EDGE_SLOP_PX &&
      unclampedX <= live.width - 1 + FRAME_POINT_EDGE_SLOP_PX &&
      unclampedY >= -FRAME_POINT_EDGE_SLOP_PX &&
      unclampedY <= live.height - 1 + FRAME_POINT_EDGE_SLOP_PX,
  };
}

function finiteFrameNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reads the captured-frame snapshot the viewer stamps onto the displayed
 * screen image (`data-frame-viewport-*`). Returns undefined when the image
 * carries no snapshot (legacy frame) so the command falls back to the
 * live-viewport mapping instead of failing.
 */
export function parseFrameViewportFromDataset(dataset: DOMStringMap): RemoteMouseFrameViewport | undefined {
  const width = finiteFrameNumber(
    dataset.frameViewportWidth !== undefined && dataset.frameViewportWidth !== ""
      ? Number(dataset.frameViewportWidth)
      : NaN
  );
  const height = finiteFrameNumber(
    dataset.frameViewportHeight !== undefined && dataset.frameViewportHeight !== ""
      ? Number(dataset.frameViewportHeight)
      : NaN
  );
  const scrollX = finiteFrameNumber(
    dataset.frameViewportScrollX !== undefined && dataset.frameViewportScrollX !== ""
      ? Number(dataset.frameViewportScrollX)
      : NaN
  );
  const scrollY = finiteFrameNumber(
    dataset.frameViewportScrollY !== undefined && dataset.frameViewportScrollY !== ""
      ? Number(dataset.frameViewportScrollY)
      : NaN
  );
  const visualScale = finiteFrameNumber(
    dataset.frameViewportVisualScale !== undefined && dataset.frameViewportVisualScale !== ""
      ? Number(dataset.frameViewportVisualScale)
      : NaN
  );
  if (width === null || height === null || scrollX === null || scrollY === null || visualScale === null) {
    return undefined;
  }
  return { width, height, scrollX, scrollY, visualScale };
}

// prettier-ignore
export function isRemoteMouseBlockedElement(element: Element | null): boolean {
  if (!element) return true;
  const blocked = element.closest(BLOCKED_SELECTOR);
  if (blocked) return true;

  const clickable = element.closest(CLICKABLE_SELECTOR);
  return !!clickable && DANGEROUS_TEXT.test(elementDescriptor(clickable));
}

export function isAllowedRemoteClickElement(
  element: Element | null,
  location: Location = window.location
): element is HTMLElement {
  if (!element || isRemoteMouseBlockedElement(element)) return false;
  const clickable = element.closest(CLICKABLE_SELECTOR);
  if (!(clickable instanceof HTMLElement)) return false;

  // Explicit registry — generated allowlist via data-remote-control-action.
  // This is the primary usable allowlist: every allowlisted control carries
  // a vetted action from the registry. It cannot override blocked/dangerous
  // checks above, which fail closed first.
  const action = clickable.getAttribute("data-remote-control-action");
  if (action != null) {
    // Presence of the attribute opts the element into registry checking.
    // An unregistered action is not allowlisted, even if its text would
    // otherwise match the heuristic.
    if (isRegisteredRemoteControlAction(action.trim())) return true;
    return false;
  }

  if (clickable.getAttribute("data-remote-control-safe") === "true") return true;
  if (clickable.getAttribute("role") === "tab" || clickable.tagName === "SUMMARY") return true;
  if (clickable instanceof HTMLAnchorElement) {
    return isSameOriginNavigation(clickable, location) && !DANGEROUS_TEXT.test(elementDescriptor(clickable));
  }

  const descriptor = elementDescriptor(clickable);
  return !!descriptor && SAFE_ACTION_TEXT.test(descriptor) && !DANGEROUS_TEXT.test(descriptor);
}

export const REMOTE_WHEEL_DELTA_MODE_PIXEL = 0;
export const REMOTE_WHEEL_DELTA_MODE_LINE = 1;
export const REMOTE_WHEEL_DELTA_MODE_PAGE = 2;
/**
 * Approximate CSS pixels per wheel line. Line-mode controllers (Firefox)
 * report ~3 lines per notch; 40 px/line restores the ~120 px per notch that
 * pixel-mode browsers scroll, matching the widely used normalize-wheel
 * heuristic.
 */
export const REMOTE_WHEEL_LINE_HEIGHT_PX = 40;
export const REMOTE_WHEEL_FALLBACK_PAGE_WIDTH_PX = 1024;
export const REMOTE_WHEEL_FALLBACK_PAGE_HEIGHT_PX = 768;

/**
 * Wheel deltas are only pixels when `deltaMode` is `DOM_DELTA_PIXEL`.
 * Line-mode events (Firefox: ~3 per notch) and page-mode events would
 * otherwise be forwarded raw and scroll 1–3 px — i.e. no visible scrolling
 * at all. Normalization happens on the controller, where the event and its
 * units live; the target only ever receives pixels.
 *
 * Page-mode deltas are scaled by the target's page size, taken from the
 * captured frame viewport the controller is looking at.
 */
export function normalizeRemoteWheelDelta(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  pageWidth?: number,
  pageHeight?: number
): { deltaX: number; deltaY: number } {
  const safeDeltaX = Number.isFinite(deltaX) ? deltaX : 0;
  const safeDeltaY = Number.isFinite(deltaY) ? deltaY : 0;
  if (deltaMode === REMOTE_WHEEL_DELTA_MODE_LINE) {
    return {
      deltaX: safeDeltaX * REMOTE_WHEEL_LINE_HEIGHT_PX,
      deltaY: safeDeltaY * REMOTE_WHEEL_LINE_HEIGHT_PX,
    };
  }
  if (deltaMode === REMOTE_WHEEL_DELTA_MODE_PAGE) {
    return {
      deltaX: safeDeltaX * finitePositive(pageWidth, REMOTE_WHEEL_FALLBACK_PAGE_WIDTH_PX),
      deltaY: safeDeltaY * finitePositive(pageHeight, REMOTE_WHEEL_FALLBACK_PAGE_HEIGHT_PX),
    };
  }
  return { deltaX: safeDeltaX, deltaY: safeDeltaY };
}

// prettier-ignore
function canScrollInDirection(element: HTMLElement, deltaX: number, deltaY: number): boolean {
  const canScrollX =
    deltaX < 0
      ? element.scrollLeft > 0
      : deltaX > 0 && element.scrollLeft + element.clientWidth < element.scrollWidth;
  const canScrollY =
    deltaY < 0
      ? element.scrollTop > 0
      : deltaY > 0 && element.scrollTop + element.clientHeight < element.scrollHeight;
  return canScrollX || canScrollY;
}

// prettier-ignore
function nearestScrollableElement(
  element: Element | null,
  view: Window,
  deltaX: number,
  deltaY: number
): HTMLElement | null {
  let current = element instanceof HTMLElement ? element : null;
  while (current && current !== view.document.body) {
    const style = view.getComputedStyle(current);
    const scrollableX = /(auto|scroll)/.test(style.overflowX) && current.scrollWidth > current.clientWidth;
    const scrollableY = /(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight;
    if ((scrollableX || scrollableY) && canScrollInDirection(current, deltaX, deltaY)) return current;
    current = current.parentElement;
  }
  return null;
}

export function applyRemoteMouseCommand(
  command: RemoteMouseCommandView,
  documentRef: Document = document,
  view: Window = window,
  options: RemoteMouseExecutionOptions = {}
): RemoteMouseExecutionResult {
  const mappedPoint = mapRemoteMouseFramePoint(command.x, command.y, command.frameViewport, view);
  if (!mappedPoint) {
    return { status: "ignored", reason: "invalid-coordinates", clientX: 0, clientY: 0 };
  }

  const { clientX, clientY, onScreen } = mappedPoint;
  const target = documentRef.elementFromPoint(clientX, clientY);

  if (command.type === "pointer-move") {
    return { status: "executed", reason: null, clientX, clientY };
  }

  if (command.type === "scroll") {
    const deltaX = typeof command.deltaX === "number" && Number.isFinite(command.deltaX) ? command.deltaX : 0;
    const deltaY = typeof command.deltaY === "number" && Number.isFinite(command.deltaY) ? command.deltaY : 0;
    if (deltaX === 0 && deltaY === 0) {
      return { status: "ignored", reason: "empty-scroll", clientX, clientY };
    }
    if (!target) {
      return { status: "ignored", reason: "no-target", clientX, clientY };
    }

    // Scrolling is exempt from frame-viewport staleness by design: the scroll
    // itself is what invalidates the captured scroll position, so requiring a
    // fresh frame would drop every scroll after the first. The anchor above
    // was still remapped through the frame snapshot, so the scroll targets
    // the container the controller was pointing at.
    const scrollTarget = nearestScrollableElement(target, view, deltaX, deltaY);
    if (scrollTarget) {
      scrollTarget.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" });
    } else {
      view.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" });
    }
    return { status: "executed", reason: null, clientX, clientY };
  }

  // The click point was remapped through the frame snapshot above, so pure
  // viewport drift keeps the click on the aimed content. When the remapped
  // point falls outside the live viewport, the aimed content is no longer
  // visible and there is nothing accurate to click — ignore rather than land
  // on whatever moved into the clamped position.
  if (!onScreen) {
    return { status: "ignored", reason: "frame-point-offscreen", clientX, clientY };
  }

  if (!target) {
    return { status: "ignored", reason: "no-target", clientX, clientY };
  }

  if (options.keyboardEnabled && focusRemoteEditableElement(target)) {
    return { status: "executed", reason: null, clientX, clientY };
  }
  clearRemoteEditableFocus();

  if (isRemoteMouseBlockedElement(target)) {
    return { status: "blocked", reason: "protected-element", clientX, clientY };
  }

  if (!isAllowedRemoteClickElement(target, view.location)) {
    return { status: "blocked", reason: "action-not-allowlisted", clientX, clientY };
  }

  const clickable = target.closest(CLICKABLE_SELECTOR);
  if (!(clickable instanceof HTMLElement)) {
    return { status: "ignored", reason: "no-clickable-target", clientX, clientY };
  }

  try {
    clickable.focus({ preventScroll: true });
    clickable.click();
    return { status: "executed", reason: null, clientX, clientY };
  } catch {
    return { status: "ignored", reason: "click-failed", clientX, clientY };
  }
}