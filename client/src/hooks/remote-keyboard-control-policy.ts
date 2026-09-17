export type RemoteKeyboardCommandType = "insert-text" | "key";
export type RemoteKeyboardExecutionStatus = "executed" | "blocked" | "ignored";
export type RemoteKeyboardKey =
  | "Backspace"
  | "Delete"
  | "Tab"
  | "Escape"
  | "Enter"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "Space";

export interface RemoteKeyboardCommandView {
  id: string;
  sessionId: string;
  type: RemoteKeyboardCommandType;
  sequence: number;
  text?: string;
  key?: RemoteKeyboardKey;
  shiftKey: boolean;
  createdAt?: string;
}

export interface RemoteKeyboardExecutionResult {
  status: RemoteKeyboardExecutionStatus;
  reason: string | null;
}

type RemoteEditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const LOCAL_ACTIVITY_BLOCK_MS = 1200;
const SAFE_TEXT_INPUT_TYPES = new Set([
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
const SENSITIVE_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-name",
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "transaction-amount",
  "transaction-currency",
]);

// These descriptors are intrinsically sensitive. A "search" label must never
// override them, even when the field is explicitly marked editable.
const HARD_SENSITIVE_DESCRIPTOR = new RegExp(
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
    "كلمة المرور",
    "دفع",
    "مبلغ",
    "حذف",
    "صلاحية",
    "mot de passe",
    "paiement",
    "montant",
    "supprimer",
    "autorisation",
  ].join("|"),
  "i"
);

// Entity words are common in harmless filters ("Customer name", "Supplier
// code", "Item description"). They are only sensitive when there is no clear
// filter intent and no explicit field annotation.
const BUSINESS_ENTITY_DESCRIPTOR = /\b(?:supplier|customer|employee|company)\b/i;

const SAFE_FILTER_DESCRIPTOR = new RegExp(
  [
    "search",
    "filter",
    "find",
    "lookup",
    "query",
    "from date",
    "to date",
    "start date",
    "end date",
    "reference",
    "code",
    "name",
    "note",
    "description",
    "item",
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
    "ملاحظات",
    "وصف",
  ].join("|"),
  "i"
);

let remoteFocusedElement: RemoteEditableElement | null = null;
let lastTrustedLocalInteractionAt = 0;

function elementDescriptor(element: RemoteEditableElement): string {
  const labelText = element.labels
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
    labelText,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isExplicitlyEditable(element: HTMLElement): boolean {
  return element.getAttribute("data-remote-control-editable") === "true";
}

function isProtectedContainer(element: HTMLElement): boolean {
  return !!element.closest(
    "[data-remote-control-blocked='true'],[data-sensitive-action],[data-destructive],[data-screenfeed-ignore='true']"
  );
}

function safeFilterIntent(element: RemoteEditableElement): boolean {
  return SAFE_FILTER_DESCRIPTOR.test(elementDescriptor(element));
}

export function isSafeRemoteEditableElement(element: Element | null): element is RemoteEditableElement {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
    return false;
  }
  const readOnly = (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.readOnly;
  if (element.disabled || readOnly || isProtectedContainer(element)) return false;

  const descriptor = elementDescriptor(element);
  const explicit = isExplicitlyEditable(element);
  const filterLike = SAFE_FILTER_DESCRIPTOR.test(descriptor);
  if (HARD_SENSITIVE_DESCRIPTOR.test(descriptor)) return false;
  if (BUSINESS_ENTITY_DESCRIPTOR.test(descriptor) && !explicit && !filterLike) return false;

  const autocomplete = element.getAttribute("autocomplete")?.trim().toLowerCase() ?? "";
  if (SENSITIVE_AUTOCOMPLETE.has(autocomplete)) return false;

  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === "password" || type === "hidden" || type === "file") return false;
    if (type === "checkbox" || type === "radio") return explicit;
    if (!SAFE_TEXT_INPUT_TYPES.has(type)) return false;
  }
  if (element instanceof HTMLSelectElement && !explicit && !filterLike) return false;

  // Fields inside forms stay fail-closed unless their descriptor clearly marks
  // them as filter/search UI or the page explicitly opts them in. This avoids
  // reopening write forms while removing the old blanket form exclusion.
  if (element.form && !explicit && !filterLike) return false;
  return explicit || filterLike || !element.form;
}

export function focusRemoteEditableElement(element: Element | null): boolean {
  if (!isSafeRemoteEditableElement(element)) {
    remoteFocusedElement = null;
    return false;
  }
  remoteFocusedElement = element;
  element.focus({ preventScroll: true });
  return true;
}

export function clearRemoteEditableFocus(): void {
  remoteFocusedElement = null;
}

export function noteTrustedLocalRemoteControlInteraction(now = Date.now()): void {
  lastTrustedLocalInteractionAt = now;
  remoteFocusedElement = null;
}

export function getRemoteEditableFocus(): RemoteEditableElement | null {
  if (!remoteFocusedElement || !remoteFocusedElement.isConnected) remoteFocusedElement = null;
  return remoteFocusedElement;
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function dispatchValueEvents(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  inputType?: string,
  data?: string | null
): void {
  if (!(element instanceof HTMLSelectElement)) {
    try {
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: false,
          inputType: inputType ?? "insertText",
          data: data ?? null,
        })
      );
    } catch {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function replaceSelection(
  element: HTMLInputElement | HTMLTextAreaElement,
  replacement: string,
  inputType: string
): boolean {
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;
  const next = `${element.value.slice(0, start)}${replacement}${element.value.slice(end)}`;
  if (element.maxLength >= 0 && Array.from(next).length > element.maxLength) return false;
  setNativeValue(element, next);
  const caret = start + replacement.length;
  try {
    element.setSelectionRange(caret, caret);
  } catch {
    // Number/date inputs do not support text selection in every browser.
  }
  dispatchValueEvents(element, inputType, replacement || null);
  return true;
}

function dispatchKey(element: HTMLElement, key: string, shiftKey: boolean): void {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
  element.dispatchEvent(new KeyboardEvent("keyup", { key, shiftKey, bubbles: true, cancelable: true }));
}

function focusAdjacentEditable(current: RemoteEditableElement, reverse: boolean, documentRef: Document): boolean {
  const candidates = Array.from(documentRef.querySelectorAll("input,textarea,select")).filter(isSafeRemoteEditableElement);
  if (candidates.length === 0) return false;
  const index = Math.max(0, candidates.indexOf(current));
  const nextIndex = reverse ? (index - 1 + candidates.length) % candidates.length : (index + 1) % candidates.length;
  remoteFocusedElement = candidates[nextIndex];
  remoteFocusedElement.focus({ preventScroll: true });
  return true;
}

function applySelectKey(element: HTMLSelectElement, key: RemoteKeyboardKey): boolean {
  if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "Home" && key !== "End") return false;
  const enabledOptions = Array.from(element.options).filter((option) => !option.disabled);
  if (enabledOptions.length === 0) return false;
  const current = Math.max(0, enabledOptions.findIndex((option) => option === element.selectedOptions[0]));
  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? enabledOptions.length - 1
        : key === "ArrowUp"
          ? Math.max(0, current - 1)
          : Math.min(enabledOptions.length - 1, current + 1);
  element.value = enabledOptions[next].value;
  dispatchValueEvents(element);
  return true;
}

function applyCheckboxKey(element: HTMLInputElement, key: RemoteKeyboardKey): boolean {
  if ((element.type !== "checkbox" && element.type !== "radio") || key !== "Space") return false;
  if (!isExplicitlyEditable(element)) return false;
  if (element.type === "checkbox") element.checked = !element.checked;
  else element.checked = true;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

export function applyRemoteKeyboardCommand(
  command: RemoteKeyboardCommandView,
  documentRef: Document = document,
  now = Date.now()
): RemoteKeyboardExecutionResult {
  if (now - lastTrustedLocalInteractionAt < LOCAL_ACTIVITY_BLOCK_MS) {
    return { status: "blocked", reason: "local-user-active" };
  }

  const element = getRemoteEditableFocus();
  if (!element || !isSafeRemoteEditableElement(element)) {
    return { status: "blocked", reason: "no-safe-editable-focus" };
  }

  if (command.type === "insert-text") {
    if (
      typeof command.text !== "string" ||
      command.text.length === 0 ||
      Array.from(command.text).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      })
    ) {
      return { status: "ignored", reason: "invalid-text" };
    }
    if (
      element instanceof HTMLSelectElement ||
      (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type))
    ) {
      return { status: "blocked", reason: "text-not-supported" };
    }
    const applied = replaceSelection(element, command.text, "insertText");
    return applied ? { status: "executed", reason: null } : { status: "blocked", reason: "field-length-limit" };
  }

  const key = command.key;
  if (!key) return { status: "ignored", reason: "invalid-key" };
  dispatchKey(element, key === "Space" ? " " : key, command.shiftKey);

  if (key === "Escape") {
    element.blur();
    remoteFocusedElement = null;
    return { status: "executed", reason: null };
  }
  if (key === "Tab") {
    return focusAdjacentEditable(element, command.shiftKey, documentRef)
      ? { status: "executed", reason: null }
      : { status: "ignored", reason: "no-adjacent-field" };
  }
  if (element instanceof HTMLSelectElement) {
    return applySelectKey(element, key)
      ? { status: "executed", reason: null }
      : { status: "blocked", reason: "select-key-blocked" };
  }
  if (element instanceof HTMLInputElement && applyCheckboxKey(element, key)) {
    return { status: "executed", reason: null };
  }
  if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
    return { status: "blocked", reason: "checkbox-key-blocked" };
  }

  if (key === "Enter") {
    if (element instanceof HTMLTextAreaElement) {
      return replaceSelection(element, "\n", "insertLineBreak")
        ? { status: "executed", reason: null }
        : { status: "blocked", reason: "field-length-limit" };
    }
    // dispatchKey above lets React/onKeyDown search handlers run. Native form
    // submission is intentionally not synthesized: safe search/filter controls
    // are completable without remotely submitting an arbitrary write form.
    if (isExplicitlyEditable(element) || safeFilterIntent(element)) {
      return { status: "executed", reason: null };
    }
    return { status: "blocked", reason: "form-submit-blocked" };
  }
  if (key === "Space") {
    return replaceSelection(element, " ", "insertText")
      ? { status: "executed", reason: null }
      : { status: "blocked", reason: "field-length-limit" };
  }
  if (key === "Backspace" || key === "Delete") {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    if (start !== end) {
      return replaceSelection(element, "", key === "Backspace" ? "deleteContentBackward" : "deleteContentForward")
        ? { status: "executed", reason: null }
        : { status: "ignored", reason: "delete-failed" };
    }
    if (key === "Backspace" && start > 0) {
      try {
        element.setSelectionRange(start - 1, end);
      } catch {
        return { status: "blocked", reason: "selection-not-supported" };
      }
      return replaceSelection(element, "", "deleteContentBackward")
        ? { status: "executed", reason: null }
        : { status: "ignored", reason: "delete-failed" };
    }
    if (key === "Delete" && start < element.value.length) {
      try {
        element.setSelectionRange(start, start + 1);
      } catch {
        return { status: "blocked", reason: "selection-not-supported" };
      }
      return replaceSelection(element, "", "deleteContentForward")
        ? { status: "executed", reason: null }
        : { status: "ignored", reason: "delete-failed" };
    }
    return { status: "ignored", reason: "nothing-to-delete" };
  }

  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;
  let next = start;
  if (key === "ArrowLeft") next = Math.max(0, start - 1);
  else if (key === "ArrowRight") next = Math.min(element.value.length, end + 1);
  else if (key === "Home") next = 0;
  else if (key === "End") next = element.value.length;
  else if (key === "ArrowUp" || key === "ArrowDown") {
    if (element instanceof HTMLInputElement && element.type === "number" && isExplicitlyEditable(element)) {
      try {
        key === "ArrowUp" ? element.stepUp() : element.stepDown();
        dispatchValueEvents(element);
        return { status: "executed", reason: null };
      } catch {
        return { status: "blocked", reason: "number-step-blocked" };
      }
    }
    return { status: "ignored", reason: "vertical-key-not-supported" };
  }

  try {
    element.setSelectionRange(next, next);
    return { status: "executed", reason: null };
  } catch {
    return { status: "blocked", reason: "selection-not-supported" };
  }
}
