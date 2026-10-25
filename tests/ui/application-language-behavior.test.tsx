/**
 * ApplicationLanguageProvider owns the interface language: it starts from the
 * browser's saved choice, adopts the account's saved preference unless the
 * user has just picked one, persists choices to storage, cookie and server,
 * follows other tabs, sets the document direction, announces changes, and
 * falls back to English while a catalog is still loading.
 */
import React from "react";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { APPLICATION_LANGUAGE_EVENT, APPLICATION_LANGUAGE_STORAGE_KEY } from "@shared/applicationLanguageContract";
import { queryClient } from "@/lib/queryClient";
import {
  ApplicationLanguageProvider,
  useApplicationDirection,
  useApplicationLanguage,
} from "@/contexts/ApplicationLanguageContext";
import { translateApplicationText } from "@/i18n/applicationTranslations";
import { installFakeApi, respond, type FakeApi } from "./fakeApi";

vi.mock("@/components/ApplicationInterfaceTranslator", () => ({
  ApplicationInterfaceTranslator: ({ language }: { language: string }) => (
    <div data-testid="interface-translator">{language}</div>
  ),
}));

let api: FakeApi;

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ApplicationLanguageProvider>{children}</ApplicationLanguageProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  queryClient.clear();
  localStorage.clear();
  document.cookie = "erp_application_language=; Max-Age=0; Path=/";
  document.documentElement.removeAttribute("dir");
  document.documentElement.removeAttribute("lang");
  window.history.replaceState({}, "", "/dashboard");
  api = installFakeApi();
  api.get("/api/language-preference", {});
  api.put("/api/language-preference", ({ body }) => body as object);
});

afterEach(() => window.history.replaceState({}, "", "/"));

describe("ApplicationLanguageProvider", () => {
  it("starts in English, left to right, when nothing is saved", async () => {
    const { result } = renderHook(() => useApplicationLanguage(), { wrapper });

    expect(result.current.language).toBe("en");
    expect(result.current.direction).toBe("ltr");
    expect(result.current.t("language.changed")).toBe(translateApplicationText("language.changed", "en"));
    await waitFor(() => expect(api.callsTo("GET", "/api/language-preference")).toHaveLength(1));
  });

  it("starts from the browser's saved language", () => {
    localStorage.setItem(APPLICATION_LANGUAGE_STORAGE_KEY, "fr");

    const { result } = renderHook(() => useApplicationLanguage(), { wrapper });

    expect(result.current.language).toBe("fr");
  });

  it("adopts the account's saved language and persists it to the browser", async () => {
    api.get("/api/language-preference", { preferredLanguage: "ar" });

    const { result } = renderHook(() => useApplicationLanguage(), { wrapper });

    await waitFor(() => expect(result.current.language).toBe("ar"));
    expect(result.current.direction).toBe("rtl");
    expect(localStorage.getItem(APPLICATION_LANGUAGE_STORAGE_KEY)).toBe("ar");
    expect(document.cookie).toContain("erp_application_language=ar");
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
  });

  it("does not ask the server for a preference on the login page", async () => {
    window.history.replaceState({}, "", "/login");

    renderHook(() => useApplicationLanguage(), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(api.callsTo("GET", "/api/language-preference")).toHaveLength(0);
  });

  it("saves a chosen language everywhere and tells other listeners", async () => {
    const heard: string[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent<string>).detail);
    window.addEventListener(APPLICATION_LANGUAGE_EVENT, listener);
    const { result } = renderHook(() => useApplicationLanguage(), { wrapper });

    act(() => result.current.setLanguage("fr"));

    expect(result.current.language).toBe("fr");
    expect(localStorage.getItem(APPLICATION_LANGUAGE_STORAGE_KEY)).toBe("fr");
    expect(heard).toEqual(["fr"]);
    await waitFor(() =>
      expect(api.callsTo("PUT", "/api/language-preference")[0]?.body).toEqual({ preferredLanguage: "fr" })
    );
    window.removeEventListener(APPLICATION_LANGUAGE_EVENT, listener);
  });

  it("keeps the user's fresh choice over a late server preference", async () => {
    let releaseServer!: (value: object) => void;
    api.get(
      "/api/language-preference",
      () =>
        new Promise<object>((resolve) => {
          releaseServer = resolve;
        })
    );
    // Hold the save open too, so its success cannot overwrite the late server value.
    api.put("/api/language-preference", () => new Promise<Response>(() => {}));
    const { result } = renderHook(() => useApplicationLanguage(), { wrapper });
    await waitFor(() => expect(api.callsTo("GET", "/api/language-preference")).toHaveLength(1));

    act(() => result.current.setLanguage("fr"));
    await act(async () => {
      releaseServer({ preferredLanguage: "ar" });
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(["/api/language-preference"])).toEqual({ preferredLanguage: "ar" })
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(result.current.language).toBe("fr");
  });

  it("treats an unknown language as English", () => {
    const { result } = renderHook(() => useApplicationLanguage(), { wrapper });

    act(() => result.current.setLanguage("de" as never));

    expect(result.current.language).toBe("en");
  });

  it("follows a language change made in another tab or by another component", () => {
    const { result } = renderHook(() => useApplicationLanguage(), { wrapper });

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: APPLICATION_LANGUAGE_STORAGE_KEY, newValue: "ar" }));
    });
    expect(result.current.language).toBe("ar");

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "fr" }));
    });
    expect(result.current.language).toBe("ar");

    act(() => {
      window.dispatchEvent(new CustomEvent(APPLICATION_LANGUAGE_EVENT, { detail: "fr" }));
    });
    expect(result.current.language).toBe("fr");
  });

  it("announces the change and mounts the interface translator once the catalog is ready", async () => {
    function Picker() {
      const { setLanguage } = useApplicationLanguage();
      return <button onClick={() => setLanguage("fr")}>French</button>;
    }
    render(<Picker />, { wrapper });

    act(() => screen.getByText("French").click());

    await waitFor(() => expect(screen.getByTestId("interface-translator")).toHaveTextContent("fr"));
    await waitFor(() =>
      expect(screen.getByTestId("application-language-announcement")).toHaveTextContent(
        translateApplicationText("language.changed", "fr")
      )
    );
  });

  it("does not break when the server refuses to save the preference", async () => {
    api.put("/api/language-preference", respond(500, { message: "down" }));
    const { result } = renderHook(() => useApplicationLanguage(), { wrapper });

    act(() => result.current.setLanguage("ar"));

    await waitFor(() => expect(api.callsTo("PUT", "/api/language-preference")).toHaveLength(1));
    await waitFor(() => expect(result.current.isSaving).toBe(false));
    expect(result.current.language).toBe("ar");
  });
});

describe("language hooks outside the provider", () => {
  it("useApplicationLanguage refuses to run without the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useApplicationLanguage())).toThrow(/inside ApplicationLanguageProvider/);
    vi.restoreAllMocks();
  });

  it("useApplicationDirection falls back to the document direction", () => {
    expect(renderHook(() => useApplicationDirection()).result.current).toBe("ltr");
    document.documentElement.dir = "rtl";
    expect(renderHook(() => useApplicationDirection()).result.current).toBe("rtl");
  });
});
