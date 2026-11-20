/**
 * biometricCredentials against the real @capacitor/preferences and
 * @aparajita/capacitor-secure-storage plugins (their web implementations store
 * into localStorage under different keys, so the tests can see which one holds
 * the credentials).
 *
 * Every other suite replaces the plugin with a plain object, which hides how
 * the real one behaves: it is a Proxy that answers any property, including
 * `then`. Returned from an async function it becomes a thenable that never
 * settles, so an `await` on it hangs. That is how biometric sign-in and the
 * credential wipe on logout stopped completing. Running the real plugin's web
 * implementation (it stores into localStorage) keeps that from coming back.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearBiometricCredentials,
  loadBiometricCredentials,
  loadNativePreferences,
  loadSecureStore,
  saveBiometricCredentials,
} from "@/lib/biometricCredentials";

/** Where Capacitor Preferences kept them, in plain JSON, before the secure store. */
const PLAIN_KEY = "CapacitorStorage.biometric_creds";
const SECURE_KEY = "capacitor-storage_biometric_creds";

function settles<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("never settled")), 2000)),
  ]);
}

beforeEach(() => {
  localStorage.clear();
});

describe("biometric credentials on the real Capacitor plugins", () => {
  it("resolves the preferences handle instead of hanging on the plugin proxy", async () => {
    const preferences = await settles(loadNativePreferences());

    expect(Object.keys(preferences).sort()).toEqual(["get", "remove", "set"]);
    expect((preferences as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it("resolves the secure store handle instead of hanging on the plugin proxy", async () => {
    const store = await settles(loadSecureStore());

    expect(Object.keys(store).sort()).toEqual(["get", "remove", "set"]);
    expect((store as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it("saves the credentials in the secure store, never in plain preferences, and clears them", async () => {
    await settles(saveBiometricCredentials("operator", "s3cret"));
    expect(JSON.parse(localStorage.getItem(SECURE_KEY) as string)).toEqual({
      username: "operator",
      password: "s3cret",
    });
    expect(localStorage.getItem(PLAIN_KEY)).toBeNull();

    expect(await settles(loadBiometricCredentials())).toEqual({ username: "operator", password: "s3cret" });

    await settles(clearBiometricCredentials());
    expect(localStorage.getItem(SECURE_KEY)).toBeNull();
    expect(await settles(loadBiometricCredentials())).toBeNull();
  });

  it("reads nothing when nothing was saved", async () => {
    expect(await settles(loadBiometricCredentials())).toBeNull();
  });

  it("moves a plain copy from an older release into the secure store and deletes it", async () => {
    localStorage.setItem(PLAIN_KEY, JSON.stringify({ username: "operator", password: "s3cret" }));

    expect(await settles(loadBiometricCredentials())).toEqual({ username: "operator", password: "s3cret" });
    expect(localStorage.getItem(PLAIN_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(SECURE_KEY) as string)).toEqual({
      username: "operator",
      password: "s3cret",
    });
  });

  it("deletes an unreadable plain copy and treats it as absent", async () => {
    localStorage.setItem(PLAIN_KEY, "{not json");

    expect(await settles(loadBiometricCredentials())).toBeNull();
    expect(localStorage.getItem(PLAIN_KEY)).toBeNull();
    expect(localStorage.getItem(SECURE_KEY)).toBeNull();
  });

  it("clears a plain copy too when biometric sign-in is turned off", async () => {
    localStorage.setItem(PLAIN_KEY, JSON.stringify({ username: "operator", password: "s3cret" }));

    await settles(clearBiometricCredentials());

    expect(localStorage.getItem(PLAIN_KEY)).toBeNull();
  });

  it("reads and writes other keys through the handle", async () => {
    const preferences = await settles(loadNativePreferences());

    await settles(preferences.set({ key: "biometric_opted_in", value: "yes" }));
    expect((await settles(preferences.get({ key: "biometric_opted_in" }))).value).toBe("yes");

    await settles(preferences.remove({ key: "biometric_opted_in" }));
    expect((await settles(preferences.get({ key: "biometric_opted_in" }))).value).toBeNull();
  });
});
