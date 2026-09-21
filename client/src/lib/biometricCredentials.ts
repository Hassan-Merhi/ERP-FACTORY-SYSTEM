const CRED_KEY = "biometric_creds";

export async function loadNativePreferences() {
  const { Preferences } = await import("@capacitor/preferences");
  return Preferences;
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
