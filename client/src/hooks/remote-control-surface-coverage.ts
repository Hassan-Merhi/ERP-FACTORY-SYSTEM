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
  const labels = element.labels ? Array.from(element.labels).map((label) => label.textContent ?? "").join(" ") : "";
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

export function shouldAnnotateRemoteEditable(
  element: Element
): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
    return false;
  }
  if (element.disabled || isProtected(element)) return false;
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

function sidebarRoots(root: ParentNode): Element[] {
  return descendantsIncludingRoot<Element>(root, SIDEBAR_SELECTOR);
}

export function annotateRemoteControlSurface(root: ParentNode = document): void {
  descendantsIncludingRoot<Element>(root, FIELD_SELECTOR).forEach((element) => {
    if (shouldAnnotateRemoteEditable(element)) {
      setAttributeIfChanged(element, "data-remote-control-editable", "true");
    }
  });

  for (const sidebar of sidebarRoots(root)) {
    descendantsIncludingRoot<HTMLAnchorElement>(sidebar, SIDEBAR_LINK_SELECTOR).forEach((anchor) => {
      if (sameOriginNavigation(anchor, window.location) && !isProtected(anchor)) {
        setAttributeIfChanged(anchor, "data-remote-control-action", "navigation");
        setAttributeIfChanged(anchor, "data-remote-control-safe", "true");
      }
    });
    descendantsIncludingRoot<HTMLElement>(sidebar, SIDEBAR_BUTTON_SELECTOR).forEach((button) => {
      if (!isProtected(button)) {
        setAttributeIfChanged(button, "data-remote-control-action", "navigation");
        setAttributeIfChanged(button, "data-remote-control-safe", "true");
      }
    });
  }
}

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
      if (record.type !== "childList") continue;
      record.addedNodes.forEach((node) => {
        if (node instanceof Element && node.isConnected && root.contains(node)) pendingRoots.add(node);
      });
    }
    if (pendingRoots.size > 0) scheduleFlush();
  });
  observer.observe(root, { childList: true, subtree: true });

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
