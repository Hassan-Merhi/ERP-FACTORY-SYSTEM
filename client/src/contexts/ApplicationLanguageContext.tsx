import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  APPLICATION_LANGUAGE_COOKIE,
  APPLICATION_LANGUAGE_EVENT,
  APPLICATION_LANGUAGE_STORAGE_KEY,
  DEFAULT_APPLICATION_LANGUAGE,
  parseApplicationLanguage,
  type ApplicationLanguage,
} from "@shared/applicationLanguageContract";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { LiveRegion } from "@/components/ui/responsive-accessibility";
import {
  isApplicationTranslationCatalogLoaded,
  loadApplicationTranslationCatalog,
  translateApplicationText,
  type ApplicationTranslationKey,
} from "@/i18n/applicationTranslations";
import {
  applyApplicationLanguageToDocument,
  getApplicationDirection,
  type ApplicationDirection,
} from "@/i18n/applicationDirection";

const LazyApplicationInterfaceTranslator = lazy(() =>
  import("@/components/ApplicationInterfaceTranslator").then((module) => ({
    default: module.ApplicationInterfaceTranslator,
  }))
);

interface LanguagePreferenceResponse {
  preferredLanguage?: ApplicationLanguage;
}

interface ApplicationLanguageContextValue {
  language: ApplicationLanguage;
  direction: ApplicationDirection;
  isSaving: boolean;
  setLanguage: (language: ApplicationLanguage) => void;
  t: (key: ApplicationTranslationKey) => string;
}

const ApplicationLanguageContext = createContext<ApplicationLanguageContextValue | null>(null);

function readLocalPreference(): ApplicationLanguage {
  if (typeof window === "undefined") return DEFAULT_APPLICATION_LANGUAGE;
  return parseApplicationLanguage(window.localStorage.getItem(APPLICATION_LANGUAGE_STORAGE_KEY));
}

function persistBrowserPreference(language: ApplicationLanguage) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(APPLICATION_LANGUAGE_STORAGE_KEY, language);
  document.cookie = `${APPLICATION_LANGUAGE_COOKIE}=${language}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function ApplicationLanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<ApplicationLanguage>(readLocalPreference);
  const [announcement, setAnnouncement] = useState("");
  const [translationCatalogReady, setTranslationCatalogReady] = useState(() => isApplicationTranslationCatalogLoaded(language));
  const announcedLanguageRef = useRef(language);
  const browserPreferenceChangedRef = useRef(false);
  const isLoginRoute =
    typeof window !== "undefined" &&
    (window.location.pathname === "/login" || window.location.pathname.startsWith("/login/"));

  const preferenceQuery = useQuery<LanguagePreferenceResponse>({
    queryKey: ["/api/language-preference"],
    retry: false,
    // Language preferences are account data; the public login screen should
    // use its local/default language without probing a protected endpoint.
    enabled: !isLoginRoute,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    let cancelled = false;
    if (isApplicationTranslationCatalogLoaded(language)) {
      setTranslationCatalogReady(true);
      return;
    }

    setTranslationCatalogReady(false);
    void loadApplicationTranslationCatalog(language)
      .then(() => {
        if (!cancelled) setTranslationCatalogReady(true);
      })
      .catch(() => {
        if (!cancelled) setTranslationCatalogReady(false);
      });

    return () => {
      cancelled = true;
    };
  }, [language]);

  useEffect(() => {
    const serverLanguage = preferenceQuery.data?.preferredLanguage;
    if (!serverLanguage || browserPreferenceChangedRef.current) return;
    const normalized = parseApplicationLanguage(serverLanguage);
    setLanguageState(normalized);
    persistBrowserPreference(normalized);
  }, [preferenceQuery.data?.preferredLanguage]);

  const preferenceMutation = useMutation({
    mutationFn: async (next: ApplicationLanguage) => {
      await apiRequest("PUT", "/api/language-preference", { preferredLanguage: next });
      return next;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["/api/language-preference"], { preferredLanguage: next });
    },
  });

  const setLanguage = useCallback(
    (next: ApplicationLanguage) => {
      const normalized = parseApplicationLanguage(next);
      browserPreferenceChangedRef.current = true;
      persistBrowserPreference(normalized);
      applyApplicationLanguageToDocument(normalized);
      setLanguageState(normalized);
      window.dispatchEvent(new CustomEvent<ApplicationLanguage>(APPLICATION_LANGUAGE_EVENT, { detail: normalized }));
      preferenceMutation.mutate(normalized);
      void queryClient.invalidateQueries({ refetchType: "active" }, { cancelRefetch: false });
    },
    [preferenceMutation]
  );

  useEffect(() => {
    applyApplicationLanguageToDocument(language);
    persistBrowserPreference(language);

    if (announcedLanguageRef.current !== language) {
      announcedLanguageRef.current = language;
      setAnnouncement(translateApplicationText("language.changed", language));
    }
  }, [language]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== APPLICATION_LANGUAGE_STORAGE_KEY) return;
      browserPreferenceChangedRef.current = true;
      setLanguageState(parseApplicationLanguage(event.newValue));
    };
    const handleLanguageEvent = (event: Event) => {
      browserPreferenceChangedRef.current = true;
      setLanguageState(parseApplicationLanguage((event as CustomEvent<ApplicationLanguage>).detail));
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(APPLICATION_LANGUAGE_EVENT, handleLanguageEvent);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(APPLICATION_LANGUAGE_EVENT, handleLanguageEvent);
    };
  }, []);

  const value = useMemo<ApplicationLanguageContextValue>(
    () => ({
      language,
      direction: getApplicationDirection(language),
      isSaving: preferenceMutation.isPending,
      setLanguage,
      t: (key) => translateApplicationText(key, language),
    }),
    [language, preferenceMutation.isPending, setLanguage]
  );

  return (
    <ApplicationLanguageContext.Provider value={value}>
      {language !== "en" && translationCatalogReady ? (
        <Suspense fallback={null}>
          <LazyApplicationInterfaceTranslator language={language} />
        </Suspense>
      ) : null}
      <LiveRegion data-testid="application-language-announcement">{announcement}</LiveRegion>
      {children}
    </ApplicationLanguageContext.Provider>
  );
}

export function useApplicationLanguage() {
  const value = useContext(ApplicationLanguageContext);
  if (!value) throw new Error("useApplicationLanguage must be used inside ApplicationLanguageProvider");
  return value;
}

export function useApplicationDirection(): ApplicationDirection {
  const value = useContext(ApplicationLanguageContext);
  if (value) return value.direction;
  if (typeof document !== "undefined" && document.documentElement.dir === "rtl") return "rtl";
  return "ltr";
}
