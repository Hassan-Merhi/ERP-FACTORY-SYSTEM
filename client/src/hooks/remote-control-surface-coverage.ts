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

export function shouldAnnotateRemoteEditable(element: Element): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
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

function sidebarRoots(root: ParentNode): Element[] {
  return Array.from(
    root.querySelectorAll(
      "[data-sidebar='sidebar'],[data-sidebar='content'],[data-testid*='sidebar'],aside"
    )
  );
}

export function annotateRemoteControlSurface(root: ParentNode = document): void {
  root.querySelectorAll("input,textarea,select").forEach((element) => {
    if (shouldAnnotateRemoteEditable(element)) {
      element.setAttribute("data-remote-control-editable", "true");
    }
  });

  for (const sidebar of sidebarRoots(root)) {
    sidebar.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
      if (sameOriginNavigation(anchor, window.location) && !isProtected(anchor)) {
        anchor.setAttribute("data-remote-control-action", "navigation");
        anchor.setAttribute("data-remote-control-safe", "true");
      }
    });
    sidebar.querySelectorAll<HTMLElement>("button[data-testid*='section'],button[aria-expanded]").forEach((button) => {
      if (!isProtected(button)) {
        button.setAttribute("data-remote-control-action", "navigation");
        button.setAttribute("data-remote-control-safe", "true");
      }
    });
  }
}

export function installRemoteControlSurfaceCoverage(root: HTMLElement = document.body): () => void {
  annotateRemoteControlSurface(root);
  const observer = new MutationObserver(() => annotateRemoteControlSurface(root));
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
