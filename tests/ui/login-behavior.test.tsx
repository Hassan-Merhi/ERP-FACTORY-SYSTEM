import React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "./helpers";

const harness = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  preferencesGet: vi.fn(),
  preferencesSet: vi.fn(),
  preferencesRemove: vi.fn(),
  secureSet: vi.fn(),
  secureRemove: vi.fn(),
  setQueryData: vi.fn(),
  resetCsrfToken: vi.fn(),
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
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: harness.preferencesGet,
    set: harness.preferencesSet,
    remove: harness.preferencesRemove,
  },
}));

vi.mock("@aparajita/capacitor-secure-storage", () => ({
  KeychainAccess: { whenUnlockedThisDeviceOnly: 1 },
  SecureStorage: {
    get: vi.fn(async () => null),
    set: harness.secureSet,
    remove: harness.secureRemove,
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
    authenticate: vi.fn(),
    checkBiometry: vi.fn(),
  },
}));

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

import Login, { clearBiometricCredentials, saveBiometricCredentials } from "@/pages/Login";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  harness.preferencesGet.mockResolvedValue({ value: null });
  harness.preferencesSet.mockResolvedValue(undefined);
  harness.preferencesRemove.mockResolvedValue(undefined);
});

describe("login behavior", () => {
  it("renders credential controls and toggles password visibility", () => {
    renderWithProviders(<Login />);

    const username = screen.getByTestId("input-username") as HTMLInputElement;
    const password = screen.getByTestId("input-password") as HTMLInputElement;
    expect(username.value).toBe("");
    expect(password.type).toBe("password");

    fireEvent.change(username, { target: { value: "operator" } });
    fireEvent.change(password, { target: { value: "secret" } });
    expect(username.value).toBe("operator");
    expect(password.value).toBe("secret");

    fireEvent.click(screen.getByTestId("button-toggle-password"));
    expect(password.type).toBe("text");
    fireEvent.click(screen.getByTestId("button-toggle-password"));
    expect(password.type).toBe("password");
  });

  it("rejects an empty submission without sending a request", () => {
    renderWithProviders(<Login />);

    fireEvent.click(screen.getByTestId("button-login"));

    expect(harness.apiRequest).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledTimes(1);
  });

  it("clears the password and surfaces a failed password login", async () => {
    harness.apiRequest.mockRejectedValueOnce(new Error("invalid credentials"));
    renderWithProviders(<Login />);

    fireEvent.change(screen.getByTestId("input-username"), {
      target: { value: "operator" },
    });
    const password = screen.getByTestId("input-password") as HTMLInputElement;
    fireEvent.change(password, { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByTestId("button-login"));

    await waitFor(() => expect(harness.apiRequest).toHaveBeenCalledTimes(1));
    expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/auth/login", {
      username: "operator",
      password: "wrong-password",
    });
    await waitFor(() => expect(password.value).toBe(""));
    expect(harness.toast).toHaveBeenCalledTimes(1);
  });

  it("keeps biometric credentials in the device's secure store, never in plain preferences", async () => {
    await saveBiometricCredentials("operator", "secret");
    // Keychain access 1 is whenUnlockedThisDeviceOnly: readable only while unlocked, never migrated.
    expect(harness.secureSet).toHaveBeenCalledWith(
      "biometric_creds",
      { username: "operator", password: "secret" },
      false,
      false,
      1
    );
    expect(harness.preferencesSet).not.toHaveBeenCalledWith(expect.objectContaining({ key: "biometric_creds" }));
    // Any plain copy an older release left behind is deleted.
    expect(harness.preferencesRemove).toHaveBeenCalledWith({ key: "biometric_creds" });

    harness.preferencesRemove.mockClear();
    await clearBiometricCredentials();
    expect(harness.secureRemove).toHaveBeenCalledWith("biometric_creds", false);
    expect(harness.preferencesRemove).toHaveBeenCalledWith({ key: "biometric_creds" });
  });
});
