const SAFE_FIELD_HINT = new RegExp(
  [
    "search",
    "filter",
    "find",
    "lookup",
    "query",
    "reference",
    "code",
    "name",
    "description",
    "from[\\s_-]*date",
    "to[\\s_-]*date",
    "start[\\s_-]*date",
    "end[\\s_-]*date",
    "rechercher",
    "filtrer",
    "chercher",
    "référence",
    "nom",
    "description",
    "بحث",
    "تصفية",
    "رمز",
    "اسم",
    "وصف",
  ].join("|"),
  "i"
);

const SENSITIVE_FIELD_HINT = new RegExp(
  [
    "password",
    "passcode",
    "one[\\s_-]*time",
    "otp",
    "secret",
    "token",
    "api[\\s_-]*key",
    "credit[\\s_-]*card",
    "card[\\s_-]*number",
    "cvv",
    "cvc",
    "iban",
    "swift",
    "routing",
    "bank[\\s_-]*account",
    "account[\\s_-]*number",
    "permission",
    "role",
    "payroll",
    "salary",
    "payment",
    "debit",
    "credit",
    "amount",
    "price",
    "cost",
    "exchange[\\s_-]*rate",
    "currency",
    "voucher",
    "transfer",
    "offload",
    "approval",
    "approve",
    "delete",
    "remove",
  ].join("|"),
  "i"
);

const SAFE_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

const FIELD_SELECTOR = "input,textarea,select";
const SIDEBAR_SELECTOR = "[data-sidebar='sidebar'],[data-sidebar='content'],[data-testid*='sidebar']";
const SIDEBAR_LINK_SELECTOR = "a[href]";
const SIDEBAR_BUTTON_SELECTOR = "button[data-testid*='section'],button[aria-expanded]";

function fieldDescriptor(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  const labels = element.labels
    ? Array.from(element.labels)
        .map((label) => label.textContent ?? "")
        .join(" ")
    : "";
  return [
    element.id,
    element.getAttribute("name"),
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    element.getAttribute("title"),
    element.getAttribute("data-testid"),
    labels,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isProtected(element: HTMLElement): boolean {
  return Boolean(
    element.closest(
      "[data-remote-control-blocked='true'],[data-sensitive-action],[data-destructive],[data-screenfeed-ignore='true']"
    )
  );
}

/**
 * Controls the employee cannot reach are not controls the support agent may
 * reach either. Only explicit markers count: a portal keeps closed content
 * mounted (`hidden`, `data-state="closed"`, `inert`) and Radix marks the page
 * behind an open modal `aria-hidden`, while layout-derived visibility is not
 * available at annotation time in every host the screen feed runs in.
 */
const HIDDEN_SELECTOR = "[hidden],[aria-hidden='true'],[inert],[data-state='closed']";

function isHiddenFromView(element: Element): boolean {
  if (element.closest(HIDDEN_SELECTOR)) return true;
  for (let node = element instanceof HTMLElement ? element : null; node; node = node.parentElement) {
    if (node.style.display === "none" || node.style.visibility === "hidden") return true;
  }
  return false;
}

/** Disabled anywhere up the tree: the click would do nothing locally either. */
function isDisabled(element: Element): boolean {
  return Boolean(element.closest("[disabled],[aria-disabled='true']"));
}

export function shouldAnnotateRemoteEditable(
  element: Element
): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (!(
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  )) {
    return false;
  }
  if (element.disabled || isDisabled(element) || isProtected(element)) return false;
  if (isHiddenFromView(element)) return false;
  if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.readOnly) return false;

  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (!SAFE_INPUT_TYPES.has(type)) return false;
    if (["password", "hidden", "file", "checkbox", "radio"].includes(type)) return false;
  }

  const descriptor = fieldDescriptor(element);
  if (!descriptor || SENSITIVE_FIELD_HINT.test(descriptor)) return false;
  return SAFE_FIELD_HINT.test(descriptor);
}

function sameOriginNavigation(anchor: HTMLAnchorElement, location: Location): boolean {
  const href = anchor.getAttribute("href")?.trim() ?? "";
  if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) return false;
  if (anchor.hasAttribute("download") || anchor.target === "_blank") return false;
  try {
    return new URL(href, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

function descendantsIncludingRoot<T extends Element>(root: ParentNode, selector: string): T[] {
  const matches: T[] = [];
  if (root instanceof Element && root.matches(selector)) matches.push(root as T);
  root.querySelectorAll<T>(selector).forEach((element) => matches.push(element));
  return matches;
}

function setAttributeIfChanged(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/**
 * Annotation this module owns outright, so it may also be withdrawn. When a
 * field stops qualifying — it is disabled, hidden, or moves under a protected
 * container — the stale opt-in must not survive the change.
 */
function setOwnedAnnotation(element: Element, name: string, shouldAnnotate: boolean): void {
  if (shouldAnnotate) setAttributeIfChanged(element, name, "true");
  else if (element.hasAttribute(name)) element.removeAttribute(name);
}

/**
 * Navigation annotations are add-only: pages author their own
 * `data-remote-control-action`/`-safe` pairs, and this sweep must never
 * overwrite or withdraw a deliberate one.
 */
function annotateNavigationIfUnclaimed(element: Element): void {
  if (!element.hasAttribute("data-remote-control-action")) {
    element.setAttribute("data-remote-control-action", "navigation");
  }
  if (!element.hasAttribute("data-remote-control-safe")) {
    element.setAttribute("data-remote-control-safe", "true");
  }
}

function sidebarRoots(root: ParentNode): Element[] {
  return descendantsIncludingRoot<Element>(root, SIDEBAR_SELECTOR);
}

function isAnnotatableNavigation(element: Element): boolean {
  return !isProtected(element as HTMLElement) && !isDisabled(element) && !isHiddenFromView(element);
}

export function annotateRemoteControlSurface(root: ParentNode = document): void {
  descendantsIncludingRoot<Element>(root, FIELD_SELECTOR).forEach((element) => {
    setOwnedAnnotation(element, "data-remote-control-editable", shouldAnnotateRemoteEditable(element));
  });

  for (const sidebar of sidebarRoots(root)) {
    descendantsIncludingRoot<HTMLAnchorElement>(sidebar, SIDEBAR_LINK_SELECTOR).forEach((anchor) => {
      if (sameOriginNavigation(anchor, window.location) && isAnnotatableNavigation(anchor)) {
        annotateNavigationIfUnclaimed(anchor);
      }
    });
    descendantsIncludingRoot<HTMLElement>(sidebar, SIDEBAR_BUTTON_SELECTOR).forEach((button) => {
      if (isAnnotatableNavigation(button)) annotateNavigationIfUnclaimed(button);
    });
  }
}

/** Exactly the attributes the annotation decisions above read. */
const ANNOTATION_INPUT_ATTRIBUTES = [
  "aria-disabled",
  "aria-hidden",
  "aria-label",
  "aria-expanded",
  "data-destructive",
  "data-remote-control-blocked",
  "data-screenfeed-ignore",
  "data-sensitive-action",
  "data-sidebar",
  "data-state",
  "data-testid",
  "disabled",
  "hidden",
  "href",
  "inert",
  "name",
  "placeholder",
  "readonly",
  "style",
  "title",
  "type",
];

function minimalMutationRoots(candidates: Set<Element>): Element[] {
  const roots = Array.from(candidates).filter((element) => element.isConnected);
  return roots.filter((candidate) => !roots.some((other) => other !== candidate && other.contains(candidate)));
}

export function installRemoteControlSurfaceCoverage(root: HTMLElement = document.body): () => void {
  annotateRemoteControlSurface(root);

  const pendingRoots = new Set<Element>();
  let scheduledFrame: number | null = null;
  let disposed = false;

  const flush = () => {
    scheduledFrame = null;
    if (disposed) return;
    const roots = minimalMutationRoots(pendingRoots);
    pendingRoots.clear();
    roots.forEach((changedRoot) => annotateRemoteControlSurface(changedRoot));
  };

  const scheduleFlush = () => {
    if (scheduledFrame !== null || disposed) return;
    if (typeof window.requestAnimationFrame === "function") {
      scheduledFrame = window.requestAnimationFrame(flush);
    } else {
      scheduledFrame = window.setTimeout(flush, 16);
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") {
        record.addedNodes.forEach((node) => {
          if (node instanceof Element && node.isConnected && root.contains(node)) pendingRoots.add(node);
        });
        continue;
      }
      const target = record.target;
      if (target instanceof Element && target.isConnected && root.contains(target)) pendingRoots.add(target);
    }
    if (pendingRoots.size > 0) scheduleFlush();
  });
  // Child lists alone miss controls that are mounted first and only become
  // usable later — a portal dialog whose field is disabled until its data
  // loads, or a label applied after translation. Watching exactly the
  // attributes the decisions above read re-evaluates those controls, and
  // withdraws the annotation when one stops qualifying. The annotations this
  // module writes are deliberately absent from the filter, so a sweep cannot
  // retrigger itself.
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ANNOTATION_INPUT_ATTRIBUTES,
  });

  return () => {
    disposed = true;
    observer.disconnect();
    pendingRoots.clear();
    if (scheduledFrame !== null) {
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(scheduledFrame);
      else window.clearTimeout(scheduledFrame);
      scheduledFrame = null;
    }
  };
}
