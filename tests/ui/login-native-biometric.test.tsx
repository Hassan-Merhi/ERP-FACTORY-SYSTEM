/**
 * Login inside the Capacitor shell (Android / iOS).
 *
 * The native build is the same React bundle with window.Capacitor present, so
 * its sign-in path is ordinary client code: detect the platform, check the
 * device's biometry, remember the opt-in, and replay saved credentials after a
 * successful device prompt. None of that runs in a browser session, so nothing
 * else exercises it. Preferences here is a real key/value fake, not a call
 * recorder, so the tests assert what the device would actually hold.
 */
import React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "./helpers";

const harness = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  setQueryData: vi.fn(),
  resetCsrfToken: vi.fn(),
  authenticate: vi.fn(),
  checkBiometry: vi.fn(),
  isNativePlatform: vi.fn(),
  store: new Map<string, string>(),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/login", harness.navigate],
}));

vi.mock("@/lib/queryClient", () => ({
  apiRequest: harness.apiRequest,
  queryClient: { setQueryData: harness.setQueryData },
  resetCsrfToken: harness.resetCsrfToken,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: harness.toast }),
}));

vi.mock("@/components/ThemeToggle", () => ({
  ThemeToggle: () => <button type="button">theme</button>,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: harness.isNativePlatform },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: harness.store.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      harness.store.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      harness.store.delete(key);
    },
  },
}));

vi.mock("@aparajita/capacitor-biometric-auth", () => ({
  BiometryType: {
    faceId: "faceId",
    touchId: "touchId",
    faceAuthentication: "faceAuthentication",
    fingerprintAuthentication: "fingerprintAuthentication",
  },
  BiometricAuth: {
    authenticate: harness.authenticate,
    checkBiometry: harness.checkBiometry,
  },
}));

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

import Login from "@/pages/Login";

const CREDS_KEY = "biometric_creds";
const OPT_IN_KEY = "biometric_opted_in";
const USER = { id: "u-1", username: "operator", role: "Admin" };
const SAVED = { username: "operator", password: "s3cret" };

type NativeWindow = Window & { Capacitor?: unknown };

function loginSucceeds() {
  harness.apiRequest.mockResolvedValue({ ok: true, json: async () => USER });
}

function biometry(types: string[] = ["fingerprintAuthentication"], isAvailable = true) {
  harness.checkBiometry.mockResolvedValue({ isAvailable, biometryTypes: types });
}

async function renderNativeLogin() {
  renderWithProviders(<Login />);
  // Platform detection and the biometry check are both dynamic imports.
  await act(async () => {
    await Promise.resolve();
  });
}

function typeCredentials(username = SAVED.username, password = SAVED.password) {
  fireEvent.change(screen.getByTestId("input-username"), { target: { value: username } });
  fireEvent.change(screen.getByTestId("input-password"), { target: { value: password } });
}

function loginRequests() {
  return harness.apiRequest.mock.calls.filter(([method, url]) => method === "POST" && url === "/api/auth/login");
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.store.clear();
  localStorage.clear();
  (window as NativeWindow).Capacitor = { platform: "android" };
  harness.isNativePlatform.mockReturnValue(true);
  harness.authenticate.mockResolvedValue(undefined);
  biometry();
});

afterEach(() => {
  delete (window as NativeWindow).Capacitor;
  vi.useRealTimers();
});

describe("native login: first sign-in on a device with biometrics", () => {
  it("asks before storing anything, and stores nothing until the user answers", async () => {
    loginSucceeds();
    await renderNativeLogin();
    await waitFor(() => expect(harness.checkBiometry).toHaveBeenCalledTimes(1));

    typeCredentials();
    fireEvent.click(screen.getByTestId("button-login"));

    expect(await screen.findByTestId("button-enable-biometrics")).toBeInTheDocument();
    expect(screen.getByText("Enable Fingerprint?")).toBeInTheDocument();
    expect(harness.store.size).toBe(0);
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.setQueryData).not.toHaveBeenCalled();
  });

  it("saves the credentials and the opt-in when the user enables biometrics, then signs in", async () => {
    loginSucceeds();
    await renderNativeLogin();
    await waitFor(() => expect(harness.checkBiometry).toHaveBeenCalledTimes(1));
    typeCredentials();
    fireEvent.click(screen.getByTestId("button-login"));

    fireEvent.click(await screen.findByTestId("button-enable-biometrics"));

    await waitFor(() => expect(harness.navigate).toHaveBeenCalledWith("/"));
    expect(JSON.parse(harness.store.get(CREDS_KEY) as string)).toEqual(SAVED);
    expect(harness.store.get(OPT_IN_KEY)).toBe("yes");
    expect(harness.setQueryData).toHaveBeenCalledWith(["/api/auth/me"], USER);
    expect(harness.resetCsrfToken).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("button-enable-biometrics")).not.toBeInTheDocument();
  });

  it("records the refusal and keeps the password off the device when the user declines", async () => {
    loginSucceeds();
    await renderNativeLogin();
    await waitFor(() => expect(harness.checkBiometry).toHaveBeenCalledTimes(1));
    typeCredentials();
    fireEvent.click(screen.getByTestId("button-login"));

    fireEvent.click(await screen.findByTestId("button-decline-biometrics"));

    await waitFor(() => expect(harness.navigate).toHaveBeenCalledWith("/"));
    expect(harness.store.get(OPT_IN_KEY)).toBe("no");
    expect(harness.store.has(CREDS_KEY)).toBe(false);
    expect(harness.setQueryData).toHaveBeenCalledWith(["/api/auth/me"], USER);
  });
});

describe("native login: returning user", () => {
  it("does not ask again or store the password after an earlier refusal", async () => {
    harness.store.set(OPT_IN_KEY, "no");
    loginSucceeds();
    await renderNativeLogin();
    await waitFor(() => expect(harness.checkBiometry).toHaveBeenCalledTimes(1));

    typeCredentials();
    fireEvent.click(screen.getByTestId("button-login"));

    await waitFor(() => expect(harness.navigate).toHaveBeenCalledWith("/"));
    expect(screen.queryByTestId("button-enable-biometrics")).not.toBeInTheDocument();
    expect(harness.store.has(CREDS_KEY)).toBe(false);
  });

  it("refreshes the stored password on a password sign-in after opting in", async () => {
    harness.store.set(OPT_IN_KEY, "yes");
    loginSucceeds();
    await renderNativeLogin();
    await waitFor(() => expect(harness.checkBiometry).toHaveBeenCalledTimes(1));

    typeCredentials("operator", "changed-password");
    fireEvent.click(screen.getByTestId("button-login"));

    await waitFor(() => expect(harness.navigate).toHaveBeenCalledWith("/"));
    expect(JSON.parse(harness.store.get(CREDS_KEY) as string)).toEqual({
      username: "operator",
      password: "changed-password",
    });
    expect(screen.queryByTestId("button-enable-biometrics")).not.toBeInTheDocument();
  });

  it("prompts for biometrics on launch and signs in with the saved credentials", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    harness.store.set(CREDS_KEY, JSON.stringify(SAVED));
    harness.store.set(OPT_IN_KEY, "yes");
    loginSucceeds();
    await renderNativeLogin();
    await screen.findByTestId("button-biometric-login");
    expect(harness.authenticate).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    await waitFor(() => expect(loginRequests()).toHaveLength(1));
    expect(harness.authenticate).toHaveBeenCalledTimes(1);
    expect(harness.authenticate).toHaveBeenCalledWith(expect.objectContaining({ allowDeviceCredential: false }));
    expect(loginRequests()[0][2]).toEqual(SAVED);
    await waitFor(() => expect(harness.navigate).toHaveBeenCalledWith("/"));
  });

  it("offers the biometric button without prompting on launch when the opt-in is not recorded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    harness.store.set(CREDS_KEY, JSON.stringify(SAVED));
    await renderNativeLogin();
    await screen.findByTestId("button-biometric-login");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(harness.authenticate).not.toHaveBeenCalled();
    expect(loginRequests()).toHaveLength(0);
  });

  it("signs in from the biometric button only after the device prompt succeeds", async () => {
    harness.store.set(CREDS_KEY, JSON.stringify(SAVED));
    loginSucceeds();
    let releasePrompt: () => void = () => {};
    harness.authenticate.mockReturnValue(
      new Promise<void>((resolve) => {
        releasePrompt = resolve;
      })
    );
    await renderNativeLogin();

    fireEvent.click(await screen.findByTestId("button-biometric-login"));
    await waitFor(() => expect(harness.authenticate).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("button-biometric-login")).toHaveTextContent("Verifying…");
    expect(loginRequests()).toHaveLength(0);

    await act(async () => {
      releasePrompt();
    });

    await waitFor(() => expect(loginRequests()).toHaveLength(1));
    expect(loginRequests()[0][2]).toEqual(SAVED);
  });
});

describe("native login: biometric prompt failures", () => {
  it.each(["userCancel", "systemCancel", "appCancel"])(
    "stays quiet and sends nothing when the prompt ends with %s",
    async (code) => {
      harness.store.set(CREDS_KEY, JSON.stringify(SAVED));
      harness.authenticate.mockRejectedValue(Object.assign(new Error("cancelled"), { code }));
      await renderNativeLogin();

      fireEvent.click(await screen.findByTestId("button-biometric-login"));

      await waitFor(() => expect(harness.authenticate).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByTestId("button-biometric-login")).toHaveTextContent("Sign in with Fingerprint")
      );
      expect(harness.toast).not.toHaveBeenCalled();
      expect(loginRequests()).toHaveLength(0);
    }
  );

  it("tells the user to use the password and sends nothing when the device rejects the biometric", async () => {
    harness.store.set(CREDS_KEY, JSON.stringify(SAVED));
    harness.authenticate.mockRejectedValue(Object.assign(new Error("no match"), { code: "authenticationFailed" }));
    await renderNativeLogin();

    fireEvent.click(await screen.findByTestId("button-biometric-login"));

    await waitFor(() =>
      expect(harness.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Biometric failed", variant: "destructive" })
      )
    );
    expect(loginRequests()).toHaveLength(0);
    expect(harness.navigate).not.toHaveBeenCalled();
  });

  it("clears the password field and reports the failure when the saved password no longer works", async () => {
    harness.store.set(CREDS_KEY, JSON.stringify(SAVED));
    harness.apiRequest.mockRejectedValue(new Error("Invalid username or password"));
    await renderNativeLogin();

    fireEvent.click(await screen.findByTestId("button-biometric-login"));

    await waitFor(() =>
      expect(harness.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Login Failed", description: "Invalid username or password" })
      )
    );
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.setQueryData).not.toHaveBeenCalled();
  });
});

describe("native login: what the device supports", () => {
  it.each([
    ["faceId", "Face ID"],
    ["touchId", "Touch ID"],
    ["faceAuthentication", "Face Unlock"],
    ["fingerprintAuthentication", "Fingerprint"],
    ["irisAuthentication", "Biometrics"],
  ])("labels the button for %s as %s", async (type, label) => {
    biometry([type]);
    harness.store.set(CREDS_KEY, JSON.stringify(SAVED));
    await renderNativeLogin();

    expect(await screen.findByTestId("button-biometric-login")).toHaveTextContent(`Sign in with ${label}`);
  });

  it("hides the biometric button when there are no saved credentials", async () => {
    await renderNativeLogin();
    await waitFor(() => expect(harness.checkBiometry).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("button-biometric-login")).not.toBeInTheDocument();
  });

  it("treats unreadable saved credentials as absent instead of failing", async () => {
    harness.store.set(CREDS_KEY, "{not json");
    harness.store.set(OPT_IN_KEY, "yes");
    await renderNativeLogin();
    await waitFor(() => expect(harness.checkBiometry).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("button-biometric-login")).not.toBeInTheDocument();
    expect(harness.authenticate).not.toHaveBeenCalled();
    expect(screen.getByTestId("button-login")).toBeEnabled();
  });

  it("never offers or stores biometrics on a device without them", async () => {
    biometry([], false);
    harness.store.set(CREDS_KEY, JSON.stringify(SAVED));
    loginSucceeds();
    await renderNativeLogin();
    await waitFor(() => expect(harness.checkBiometry).toHaveBeenCalledTimes(1));
    harness.store.delete(CREDS_KEY);

    typeCredentials();
    fireEvent.click(screen.getByTestId("button-login"));

    await waitFor(() => expect(harness.resetCsrfToken).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("button-biometric-login")).not.toBeInTheDocument();
    expect(screen.queryByTestId("button-enable-biometrics")).not.toBeInTheDocument();
    expect(harness.store.size).toBe(0);
  });

  it("keeps password sign-in working when the biometry check itself throws", async () => {
    harness.checkBiometry.mockRejectedValue(new Error("plugin not implemented"));
    loginSucceeds();
    await renderNativeLogin();
    await waitFor(() => expect(harness.checkBiometry).toHaveBeenCalledTimes(1));

    typeCredentials();
    fireEvent.click(screen.getByTestId("button-login"));

    await waitFor(() => expect(loginRequests()).toHaveLength(1));
    expect(screen.queryByTestId("button-biometric-login")).not.toBeInTheDocument();
    expect(harness.store.size).toBe(0);
  });

  it("does not offer browser passkeys inside the native shell", async () => {
    Object.defineProperty(window, "PublicKeyCredential", {
      value: function PublicKeyCredential() {},
      configurable: true,
    });
    localStorage.setItem("passkey_registered_operator", "1");
    try {
      await renderNativeLogin();
      await waitFor(() => expect(harness.checkBiometry).toHaveBeenCalledTimes(1));
      fireEvent.change(screen.getByTestId("input-username"), { target: { value: "operator" } });

      expect(screen.queryByTestId("button-passkey-login")).not.toBeInTheDocument();
    } finally {
      delete (window as unknown as Record<string, unknown>).PublicKeyCredential;
    }
  });
});

describe("browser session with the Capacitor web runtime loaded", () => {
  it("stays on the web sign-in path when the bridge reports a non-native platform", async () => {
    harness.isNativePlatform.mockReturnValue(false);
    harness.store.set(CREDS_KEY, JSON.stringify(SAVED));
    harness.store.set(OPT_IN_KEY, "yes");
    await renderNativeLogin();
    await act(async () => {
      await Promise.resolve();
    });

    expect(harness.checkBiometry).not.toHaveBeenCalled();
    expect(harness.authenticate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("button-biometric-login")).not.toBeInTheDocument();
  });
});
