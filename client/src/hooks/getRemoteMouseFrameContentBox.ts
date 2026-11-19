// Extracted from ./remote-mouse-control-policy.ts to keep that module under the source-size cap.

import type {
  RemoteMouseFrameViewport,
  RemoteMouseFrameSize,
  RemoteMouseViewportMetrics,
} from "./getRemoteMouseFrameContentBoxTypes";
export type {
  RemoteMouseCommandType,
  RemoteMouseExecutionStatus,
  RemoteMouseFrameViewport,
  RemoteMouseCommandView,
  RemoteMouseExecutionResult,
  RemoteMouseExecutionOptions,
  RemoteMouseFrameSize,
  RemoteMouseViewportMetrics,
  RemoteMouseFramePointMapping,
} from "./getRemoteMouseFrameContentBoxTypes";

export const BLOCKED_SELECTOR = [
  "input",
  "textarea",
  "select",
  "option",
  // In-form controls stay blocked unless they carry a vetted registry action.
  // data-remote-control-safe is a free-form annotation any element can set, so
  // it is deliberately NOT an escape hatch here: a safe annotation must never
  // make a form submit remotely clickable.
  "form :is(button,a[href],[role='button'],[role='link'],[role='menuitem']):not([data-remote-control-action])",
  "[contenteditable]:not([contenteditable='false'])",
  "[data-remote-control-blocked='true']",
  "[data-sensitive-action]",
  "[data-destructive]",
  "[data-screenfeed-ignore='true']",
  "[disabled]",
  "[aria-disabled='true']",
].join(",");

export const CLICKABLE_SELECTOR = [
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

export const DANGEROUS_TEXT = new RegExp(
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

export const SAFE_ACTION_TEXT = new RegExp(
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

// prettier-ignore
export function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// prettier-ignore
function finiteOffset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function elementDescriptor(element: Element): string {
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

export function isSameOriginNavigation(anchor: HTMLAnchorElement, location: Location): boolean {
  const href = anchor.getAttribute("href")?.trim() ?? "";
  if (!href || href.startsWith("#") || /^(?:javascript|data|vbscript):/i.test(href)) return false;
  if (anchor.hasAttribute("download") || anchor.target === "_blank") return false;

  try {
    const target = new URL(href, location.href);
    return target.origin === location.origin;
  } catch {
    return false;
  }
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

/**
 * How far beyond the live viewport's edges a remapped frame point may sit and
 * still be treated as an in-view edge click. Absorbs the sub-pixel rounding
 * the server applies to frame snapshots; anything farther means the aimed
 * content really did scroll or reflow out of view.
 */
export const FRAME_POINT_EDGE_SLOP_PX = 2;

/**
 * Whether the live viewport can host a command at all.
 *
 * A window that reports no width or height — minimized, detached, a zero-size
 * frame — cannot be mapped into. Clamping against the 1×1 fallback below would
 * land every command on whatever sits in the top-left corner, which is usually
 * the shell's navigation, so such a command is refused instead of aimed at a
 * fabricated viewport.
 */
export function isUsableRemoteMouseViewport(view: Window = window): boolean {
  const { innerWidth, innerHeight } = view;
  return (
    typeof innerWidth === "number" &&
    Number.isFinite(innerWidth) &&
    innerWidth > 0 &&
    typeof innerHeight === "number" &&
    Number.isFinite(innerHeight) &&
    innerHeight > 0
  );
}

export function getRemoteMouseViewportMetrics(view: Window = window): RemoteMouseViewportMetrics {
  return {
    width: finitePositive(view.innerWidth, 1),
    height: finitePositive(view.innerHeight, 1),
    scrollX: finiteOffset(view.scrollX),
    scrollY: finiteOffset(view.scrollY),
  };
}

export function coerceRemoteMouseFrameViewport(
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
