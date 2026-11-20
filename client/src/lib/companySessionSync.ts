/**
 * Cross-tab hint that the authenticated server session changed company.
 *
 * The hint is deliberately not a source of truth: every receiving tab must
 * read /api/auth/session-company and verify its own company assignments.
 * The server session is shared by tabs, while React state is not.
 */
export const COMPANY_SESSION_CHANNEL = "erp-company-session";
export const COMPANY_SESSION_STORAGE_PULSE = "erp:company-session-committed";

const sourceId = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;

interface CompanySessionMessage {
  type: "company-committed";
  companyId: number;
  sourceId: string;
  nonce: string;
}

function validCompanyId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCompanySessionMessage(value: unknown): value is CompanySessionMessage {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<CompanySessionMessage>;
  return (
    event.type === "company-committed" &&
    validCompanyId(event.companyId) &&
    typeof event.sourceId === "string" &&
    typeof event.nonce === "string"
  );
}

/** Notify other tabs only after the server has accepted the switch. */
export function publishCompanySessionCommit(companyId: number): void {
  if (!validCompanyId(companyId) || typeof window === "undefined") return;
  const message: CompanySessionMessage = {
    type: "company-committed",
    companyId,
    sourceId,
    nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };

  // A separate pulse also wakes tabs when selectedCompanyId did not change.
  // Its payload is a hint, never authority to adopt a company.
  try {
    window.localStorage.setItem(COMPANY_SESSION_STORAGE_PULSE, JSON.stringify(message));
  } catch {
    // Browsers may forbid storage; BroadcastChannel still works.
  }

  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(COMPANY_SESSION_CHANNEL);
      channel.postMessage(message);
      channel.close();
    } catch {
      // Storage and resume/focus reconciliation remain available.
    }
  }
}

/**
 * Observe confirmed switches and reconcile on tab resume in case the browser
 * suspended delivery of a storage or BroadcastChannel event.
 */
export type CompanySessionSignal = "selection" | "resume";

export function subscribeToCompanySessionChanges(onChange: (signal: CompanySessionSignal) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key === "selectedCompanyId") {
      if (event.newValue && validCompanyId(Number(event.newValue))) onChange("selection");
      return;
    }
    if (event.key !== COMPANY_SESSION_STORAGE_PULSE) return;
    try {
      const message: unknown = JSON.parse(event.newValue ?? "null");
      if (isCompanySessionMessage(message) && message.sourceId !== sourceId) onChange("selection");
    } catch {
      // Ignore unrelated or malformed storage events.
    }
  };

  // Window blur/focus also happens while navigating menus, dialogs and
  // desktop apps. It is not proof the browser tab was suspended, and used to
  // interrupt ERP work with repeated verification. A real browser-tab return
  // has a hidden -> visible visibility transition. Cross-tab commit messages
  // are still handled immediately via storage/BroadcastChannel below.
  let wasHidden = typeof document !== "undefined" && document.visibilityState === "hidden";

  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") {
      wasHidden = true;
      return;
    }
    if (!wasHidden) return;
    wasHidden = false;
    onChange("resume");
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    wasHidden = false;
    onChange("resume");
  };

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(COMPANY_SESSION_CHANNEL);
      channel.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (isCompanySessionMessage(event.data) && event.data.sourceId !== sourceId) onChange("selection");
      });
    } catch {
      // Resume and storage handlers still work without BroadcastChannel.
    }
  }

  window.addEventListener("storage", onStorage);
  window.addEventListener("pageshow", onPageShow);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    channel?.close();
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("pageshow", onPageShow);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
