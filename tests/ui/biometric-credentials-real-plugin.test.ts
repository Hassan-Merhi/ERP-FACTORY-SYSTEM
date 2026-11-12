/**
 * biometricCredentials against the real @capacitor/preferences plugin.
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
  saveBiometricCredentials,
} from "@/lib/biometricCredentials";

const STORAGE_KEY = "CapacitorStorage.biometric_creds";

function settles<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("never settled")), 2000)),
  ]);
}

beforeEach(() => {
  localStorage.clear();
});

describe("biometric credentials on the real Capacitor Preferences plugin", () => {
  it("resolves the preferences handle instead of hanging on the plugin proxy", async () => {
    const preferences = await settles(loadNativePreferences());

    expect(Object.keys(preferences).sort()).toEqual(["get", "remove", "set"]);
    expect((preferences as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it("saves, reads back and clears the credentials", async () => {
    await settles(saveBiometricCredentials("operator", "s3cret"));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) as string)).toEqual({
      username: "operator",
      password: "s3cret",
    });

    expect(await settles(loadBiometricCredentials())).toEqual({ username: "operator", password: "s3cret" });

    await settles(clearBiometricCredentials());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(await settles(loadBiometricCredentials())).toBeNull();
  });

  it("reads nothing when nothing was saved", async () => {
    expect(await settles(loadBiometricCredentials())).toBeNull();
  });

  it("treats an unreadable stored value as absent", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json");

    expect(await settles(loadBiometricCredentials())).toBeNull();
  });

  it("reads and writes other keys through the handle", async () => {
    const preferences = await settles(loadNativePreferences());

    await settles(preferences.set({ key: "biometric_opted_in", value: "yes" }));
    expect((await settles(preferences.get({ key: "biometric_opted_in" }))).value).toBe("yes");

    await settles(preferences.remove({ key: "biometric_opted_in" }));
    expect((await settles(preferences.get({ key: "biometric_opted_in" }))).value).toBeNull();
  });
});
