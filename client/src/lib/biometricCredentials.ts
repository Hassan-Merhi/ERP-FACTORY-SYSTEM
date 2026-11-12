import type { PreferencesPlugin } from "@capacitor/preferences";

const CRED_KEY = "biometric_creds";

type NativePreferences = Pick<PreferencesPlugin, "get" | "set" | "remove">;

export async function loadNativePreferences(): Promise<NativePreferences> {
  const { Preferences } = await import("@capacitor/preferences");
  // A Capacitor plugin is a Proxy that answers every property, `then` included.
  // Returned directly from an async function it is treated as a thenable whose
  // `then` never settles, so the caller's await would hang forever. Hand back a
  // plain object instead.
  return {
    get: (options) => Preferences.get(options),
    set: (options) => Preferences.set(options),
    remove: (options) => Preferences.remove(options),
  };
}

export async function saveBiometricCredentials(username: string, password: string) {
  const Preferences = await loadNativePreferences();
  await Preferences.set({ key: CRED_KEY, value: JSON.stringify({ username, password }) });
}

export async function clearBiometricCredentials() {
  const Preferences = await loadNativePreferences();
  await Preferences.remove({ key: CRED_KEY });
}

export async function loadBiometricCredentials(): Promise<{ username: string; password: string } | null> {
  const Preferences = await loadNativePreferences();
  const { value } = await Preferences.get({ key: CRED_KEY });
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
