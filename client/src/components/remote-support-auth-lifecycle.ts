const AUTH_LOST_EVENT = "erp:remote-support-auth-lost";
let authLost = false;

export function isRemoteSupportAuthLost(): boolean {
  return authLost;
}

export function markRemoteSupportAuthLost(): void {
  if (authLost) return;
  authLost = true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT));
  }
}

export function subscribeRemoteSupportAuthLost(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(AUTH_LOST_EVENT, listener);
  return () => window.removeEventListener(AUTH_LOST_EVENT, listener);
}
