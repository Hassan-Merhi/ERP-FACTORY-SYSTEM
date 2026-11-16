import { clearRemoteEditableFocus, focusRemoteEditableElement } from "./remote-keyboard-control-policy";
import { isRegisteredRemoteControlAction } from "./remote-control-action-registry";
import {
  BLOCKED_SELECTOR,
  CLICKABLE_SELECTOR,
  DANGEROUS_TEXT,
  FRAME_POINT_EDGE_SLOP_PX,
  SAFE_ACTION_TEXT,
  coerceRemoteMouseFrameViewport,
  elementDescriptor,
  finitePositive,
  getRemoteMouseViewportMetrics,
  isSameOriginNavigation,
  isUsableRemoteMouseViewport,
  type RemoteMouseCommandView,
  type RemoteMouseExecutionOptions,
  type RemoteMouseExecutionResult,
  type RemoteMouseFramePointMapping,
  type RemoteMouseFrameViewport,
} from "./getRemoteMouseFrameContentBox";
export {
  FRAME_POINT_EDGE_SLOP_PX,
  getRemoteMouseFrameContentBox,
  getRemoteMouseViewportMetrics,
  isUsableRemoteMouseViewport,
  normalizeRemoteMousePoint,
} from "./getRemoteMouseFrameContentBox";
export type {
  RemoteMouseCommandType,
  RemoteMouseCommandView,
  RemoteMouseExecutionOptions,
  RemoteMouseExecutionResult,
  RemoteMouseExecutionStatus,
  RemoteMouseFramePointMapping,
  RemoteMouseFrameSize,
  RemoteMouseFrameViewport,
  RemoteMouseViewportMetrics,
} from "./getRemoteMouseFrameContentBox";

function finiteCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
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
  if (!isUsableRemoteMouseViewport(view)) return null;
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

/**
 * A control's own identity, without the text of anything nested inside it.
 *
 * `elementDescriptor` folds in `textContent`, which is right for the control
 * being clicked and wrong for its ancestors: a table or panel contains every
 * row's text, so testing an ancestor's text would block the whole page. The
 * attributes below name the ancestor itself, so they stay meaningful up the
 * tree.
 */
function controlIdentityDescriptor(element: Element): string {
  const href = element instanceof HTMLAnchorElement ? (element.getAttribute("href") ?? "") : "";
  return [
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

/**
 * A click on a safe-looking control still fires every handler above it. An
 * inner "Open" span inside a row that deletes on click would pass the
 * nearest-control check while activating the deletion, so each enclosing
 * control is checked too — by its own identity, never by the text it wraps.
 */
function hasDangerousEnclosingControl(element: Element): boolean {
  let current = element.parentElement?.closest(CLICKABLE_SELECTOR) ?? null;
  while (current) {
    if (DANGEROUS_TEXT.test(controlIdentityDescriptor(current))) return true;
    current = current.parentElement?.closest(CLICKABLE_SELECTOR) ?? null;
  }
  return false;
}

// prettier-ignore
export function isRemoteMouseBlockedElement(element: Element | null): boolean {
  if (!element) return true;
  const blocked = element.closest(BLOCKED_SELECTOR);
  if (blocked) return true;

  const clickable = element.closest(CLICKABLE_SELECTOR);
  if (!clickable) return false;
  if (DANGEROUS_TEXT.test(elementDescriptor(clickable))) return true;
  return hasDangerousEnclosingControl(clickable);
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
    // Separate causes: the controller sent an unusable point, or this window
    // has no viewport to land it in. Both refuse the command; the reason tells
    // the operator which one happened.
    const reason = isUsableRemoteMouseViewport(view) ? "invalid-coordinates" : "invalid-viewport";
    return { status: "ignored", reason, clientX: 0, clientY: 0 };
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
