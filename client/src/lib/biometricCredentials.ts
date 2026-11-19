/**
 * The username and password biometric sign-in replays.
 *
 * They live in the device's secure store: the Android Keystore (AES-GCM, key
 * never leaves the device) or the iOS Keychain, readable only while the device
 * is unlocked and never copied to another device. Releases before this kept
 * them as plain JSON in Capacitor Preferences; that copy is moved into the
 * secure store the first time it is read, and deleted.
 */
const CRED_KEY = "biometric_creds";

type Credentials = { username: string; password: string };

// Typed through the dynamic import so this module keeps no static reference to
// the native plugins, which must stay out of the authenticated startup bundle.
type PreferencesPlugin = (typeof import("@capacitor/preferences"))["Preferences"];
type NativePreferences = Pick<PreferencesPlugin, "get" | "set" | "remove">;

type SecureStore = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: Credentials) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

// A Capacitor plugin is a Proxy that answers every property, `then` included.
// Returned directly from an async function it is treated as a thenable whose
// `then` never settles, so the caller's await would hang forever. Both loaders
// hand back a plain object instead.
export async function loadNativePreferences(): Promise<NativePreferences> {
  const { Preferences } = await import("@capacitor/preferences");
  return {
    get: (options) => Preferences.get(options),
    set: (options) => Preferences.set(options),
    remove: (options) => Preferences.remove(options),
  };
}

export async function loadSecureStore(): Promise<SecureStore> {
  const { SecureStorage, KeychainAccess } = await import("@aparajita/capacitor-secure-storage");
  return {
    get: (key) => SecureStorage.get(key, false, false),
    set: (key, value) => SecureStorage.set(key, value, false, false, KeychainAccess.whenUnlockedThisDeviceOnly),
    remove: async (key) => {
      await SecureStorage.remove(key, false);
    },
  };
}

function asCredentials(value: unknown): Credentials | null {
  if (!value || typeof value !== "object") return null;
  const { username, password } = value as Record<string, unknown>;
  return typeof username === "string" && typeof password === "string" ? { username, password } : null;
}

/** Moves a plain copy left by an older release into the secure store, and deletes it either way. */
async function takeLegacyCredentials(store: SecureStore): Promise<Credentials | null> {
  const preferences = await loadNativePreferences();
  const { value } = await preferences.get({ key: CRED_KEY });
  if (!value) return null;

  let legacy: Credentials | null;
  try {
    legacy = asCredentials(JSON.parse(value));
  } catch {
    legacy = null;
  }
  if (legacy) await store.set(CRED_KEY, legacy);
  await preferences.remove({ key: CRED_KEY });
  return legacy;
}

export async function saveBiometricCredentials(username: string, password: string) {
  const store = await loadSecureStore();
  await store.set(CRED_KEY, { username, password });
  const preferences = await loadNativePreferences();
  await preferences.remove({ key: CRED_KEY });
}

export async function clearBiometricCredentials() {
  const store = await loadSecureStore();
  await store.remove(CRED_KEY);
  const preferences = await loadNativePreferences();
  await preferences.remove({ key: CRED_KEY });
}

export async function loadBiometricCredentials(): Promise<Credentials | null> {
  const store = await loadSecureStore();
  const stored = asCredentials(await store.get(CRED_KEY));
  if (stored) return stored;
  return takeLegacyCredentials(store);
}
