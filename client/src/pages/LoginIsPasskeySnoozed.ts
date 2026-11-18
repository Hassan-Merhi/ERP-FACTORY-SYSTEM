// Extracted from ./Login.tsx to keep that module under the source-size cap.

// Set to true to re-enable passkey registration & login
export const PASSKEY_ENABLED = false;

export function passkeyStorageKey(username: string) {
  return `passkey_registered_${username}`;
}

export function passkeySnoozeKey(username: string) {
  return `passkey_snoozed_${username}`;
}

export function isPasskeySnoozed(username: string) {
  const ts = localStorage.getItem(passkeySnoozeKey(username));
  if (!ts) return false;
  return Date.now() - parseInt(ts, 10) < 30 * 24 * 60 * 60 * 1000;
}

export const OPT_IN_KEY = "biometric_opted_in";

export const GOLD = "#D4AF37";

export const GOLD_LIGHT = "#F5C542";

export const GOLD_DARK = "#8A6E20";

export const BTN_BG = `linear-gradient(135deg, ${GOLD_DARK} 0%, ${GOLD_LIGHT} 50%, ${GOLD_DARK} 100%)`;

export const BTN_SHADOW = "0 4px 24px rgba(212,175,55,0.38)";
