// Extracted from ./Login.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Fingerprint, ScanFace } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, resetCsrfToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { loadBiometricCredentials, loadNativePreferences, saveBiometricCredentials } from "@/lib/biometricCredentials";
import { markChristmasLoginEntrancePending } from "@/lib/christmasLoginEntrance";
import {
  OPT_IN_KEY,
  PASSKEY_ENABLED,
  isPasskeySnoozed,
  passkeySnoozeKey,
  passkeyStorageKey,
} from "./LoginIsPasskeySnoozed";

export function useLoginState() {
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  const [biometryAvailable, setBiometryAvailable] = useState(false);
  const [biometricLabel, setBiometricLabel] = useState("Biometrics");
  const [biometricUsesFaceIcon, setBiometricUsesFaceIcon] = useState(false);
  const [hasSavedCreds, setHasSavedCreds] = useState(false);
  const [biometryPending, setBiometryPending] = useState(false);
  const [showBioPrompt, setShowBioPrompt] = useState(false);
  const pendingUserData = useRef<unknown>(null);
  const pendingCredentials = useRef<{ username: string; password: string } | null>(null);

  const [passKeyPending, setPassKeyPending] = useState(false);
  const [showPasskeyRegister, setShowPasskeyRegister] = useState(false);
  const [passkeyRegPending, setPasskeyRegPending] = useState(false);
  const [hasSavedPasskey, setHasSavedPasskey] = useState(false);
  const pendingPasskeyUser = useRef<string>("");

  const [isDark, setIsDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark")
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setIsDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  const [isNative, setIsNative] = useState(false);

  useEffect(() => {
    const capacitorBridge = (window as Window & { Capacitor?: unknown }).Capacitor;
    if (!capacitorBridge) return;

    let cancelled = false;
    void import("@capacitor/core").then(({ Capacitor }) => {
      if (!cancelled) setIsNative(Capacitor.isNativePlatform());
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isNative || !username) {
      setHasSavedPasskey(false);
      return;
    }
    setHasSavedPasskey(!!localStorage.getItem(passkeyStorageKey(username.trim())));
  }, [username, isNative]);

  const [, navigate] = useLocation();
  const passkeySupported =
    PASSKEY_ENABLED && !isNative && typeof window !== "undefined" && !!window.PublicKeyCredential;

  const finalizeLogin = () => {
    if (!pendingUserData.current) return;
    queryClient.setQueryData(["/api/auth/me"], pendingUserData.current);
    resetCsrfToken();
    pendingUserData.current = null;
    pendingCredentials.current = null;
    markChristmasLoginEntrancePending();
    navigate("/");
  };

  const loginMutation = useMutation({
    mutationFn: async (credentials: { username: string; password: string }) => {
      const res = await apiRequest("POST", "/api/auth/login", credentials);
      return await res.json();
    },
    onSuccess: async (userData, credentials) => {
      if (isNative && biometryAvailable) {
        const Preferences = await loadNativePreferences();
        const { value: optIn } = await Preferences.get({ key: OPT_IN_KEY });
        if (optIn === "yes") {
          await saveBiometricCredentials(credentials.username, credentials.password);
          setHasSavedCreds(true);
          queryClient.setQueryData(["/api/auth/me"], userData);
          resetCsrfToken();
          markChristmasLoginEntrancePending();
          navigate("/");
        } else if (optIn === "no") {
          queryClient.setQueryData(["/api/auth/me"], userData);
          resetCsrfToken();
          markChristmasLoginEntrancePending();
          navigate("/");
        } else {
          pendingUserData.current = userData;
          pendingCredentials.current = credentials;
          setShowBioPrompt(true);
        }
      } else if (!isNative && passkeySupported) {
        const alreadySaved = !!localStorage.getItem(passkeyStorageKey(credentials.username));
        const snoozed = isPasskeySnoozed(credentials.username);
        if (alreadySaved || snoozed) {
          resetCsrfToken();
          markChristmasLoginEntrancePending();
          window.location.href = "/";
        } else {
          pendingUserData.current = userData;
          pendingPasskeyUser.current = credentials.username;
          setShowPasskeyRegister(true);
        }
      } else {
        resetCsrfToken();
        markChristmasLoginEntrancePending();
        window.location.href = "/";
      }
    },
    onError: (error: ClientErrorLike) => {
      setPassword("");
      requestAnimationFrame(() => passwordInputRef.current?.focus());
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Login Failed",
        description: error.message || "Invalid username or password",
        variant: "destructive",
      });
    },
  });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginMutation.isPending || biometryPending) return;
    if (!username || !password) {
      toast({ title: "Error", description: "Please enter both username and password", variant: "destructive" });
      return;
    }
    loginMutation.mutate({ username, password });
  };

  const handleEnableBiometrics = async () => {
    setShowBioPrompt(false);
    if (pendingCredentials.current) {
      await saveBiometricCredentials(pendingCredentials.current.username, pendingCredentials.current.password);
      setHasSavedCreds(true);
    }
    const Preferences = await loadNativePreferences();
    await Preferences.set({ key: OPT_IN_KEY, value: "yes" });
    finalizeLogin();
  };

  const handleDeclineBiometrics = async () => {
    setShowBioPrompt(false);
    const Preferences = await loadNativePreferences();
    await Preferences.set({ key: OPT_IN_KEY, value: "no" });
    finalizeLogin();
  };

  const triggerBiometric = useCallback(
    async (creds?: { username: string; password: string }) => {
      setBiometryPending(true);
      try {
        const { BiometricAuth } = await import("@aparajita/capacitor-biometric-auth");
        await BiometricAuth.authenticate({
          reason: "Sign in to HMD ERP",
          cancelTitle: "Use Password",
          allowDeviceCredential: false,
        });
        const savedCreds = creds ?? (await loadBiometricCredentials());
        if (!savedCreds) {
          toast({
            title: "No saved credentials",
            description: "Please sign in with your password first.",
            variant: "destructive",
          });
          return;
        }
        loginMutation.mutate(savedCreds);
      } catch (err) {
        if (
          getErrorDetails(err).code !== "userCancel" &&
          getErrorDetails(err).code !== "systemCancel" &&
          getErrorDetails(err).code !== "appCancel"
        ) {
          toast({
            title: "Biometric failed",
            description: "Please sign in with your password.",
            variant: "destructive",
          });
        }
      } finally {
        setBiometryPending(false);
      }
    },
    [loginMutation, toast]
  );

  useEffect(() => {
    if (!isNative) return;
    void (async () => {
      try {
        const [{ BiometricAuth, BiometryType }, Preferences] = await Promise.all([
          import("@aparajita/capacitor-biometric-auth"),
          loadNativePreferences(),
        ]);
        const info = await BiometricAuth.checkBiometry();
        if (!info.isAvailable) return;

        const primaryType = info.biometryTypes?.[0];
        setBiometryAvailable(true);
        if (primaryType === BiometryType.faceId) {
          setBiometricLabel("Face ID");
          setBiometricUsesFaceIcon(true);
        } else if (primaryType === BiometryType.touchId) {
          setBiometricLabel("Touch ID");
        } else if (primaryType === BiometryType.faceAuthentication) {
          setBiometricLabel("Face Unlock");
          setBiometricUsesFaceIcon(true);
        } else if (primaryType === BiometryType.fingerprintAuthentication) {
          setBiometricLabel("Fingerprint");
        }

        const creds = await loadBiometricCredentials();
        if (!creds) return;
        setHasSavedCreds(true);
        const { value: optIn } = await Preferences.get({ key: OPT_IN_KEY });
        if (optIn === "yes") {
          setTimeout(() => triggerBiometric(creds), 600);
        }
      } catch {
        /* biometrics not available */
      }
    })();
  }, [isNative, triggerBiometric]);

  const handleRegisterPasskey = async () => {
    setPasskeyRegPending(true);
    try {
      const optionsRes = await apiRequest("POST", "/api/auth/passkey/register/options", {});
      const options = await optionsRes.json();
      const { startRegistration } = await import("@simplewebauthn/browser");
      const regResponse = await startRegistration({ optionsJSON: options });
      const verifyRes = await apiRequest("POST", "/api/auth/passkey/register/verify", {
        ...regResponse,
        deviceName: navigator.platform || "Browser",
      });
      if (!verifyRes.ok) throw new Error("Passkey registration failed");
      localStorage.setItem(passkeyStorageKey(pendingPasskeyUser.current), "1");
      setHasSavedPasskey(true);
    } catch (err) {
      if (getErrorDetails(err).name === "NotAllowedError") {
        // user cancelled
      } else {
        toast({
          title: "Passkey setup failed",
          description: getErrorDetails(err).message || "Could not save passkey",
          variant: "destructive",
        });
      }
    } finally {
      setPasskeyRegPending(false);
      setShowPasskeyRegister(false);
      resetCsrfToken();
      pendingUserData.current = null;
      markChristmasLoginEntrancePending();
      window.location.href = "/";
    }
  };

  const handleSkipPasskey = () => {
    localStorage.setItem(passkeySnoozeKey(pendingPasskeyUser.current), String(Date.now()));
    setShowPasskeyRegister(false);
    resetCsrfToken();
    pendingUserData.current = null;
    markChristmasLoginEntrancePending();
    window.location.href = "/";
  };

  const handlePasskeyLogin = async () => {
    setPassKeyPending(true);
    try {
      const optionsRes = await apiRequest("POST", "/api/auth/passkey/authenticate/options", {
        username: username || undefined,
      });
      const options = await optionsRes.json();
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const assertion = await startAuthentication({ optionsJSON: options });
      const verifyRes = await apiRequest("POST", "/api/auth/passkey/authenticate/verify", assertion);
      if (!verifyRes.ok) {
        const err = await verifyRes.json();
        throw new Error(err.message || "Passkey verification failed");
      }
      resetCsrfToken();
      markChristmasLoginEntrancePending();
      window.location.href = "/";
    } catch (err) {
      if (getErrorDetails(err).name === "NotAllowedError") return;
      toast({
        title: "Passkey failed",
        description: getErrorDetails(err).message || "Could not sign in with passkey",
        variant: "destructive",
      });
    } finally {
      setPassKeyPending(false);
    }
  };

  const showBiometricButton = isNative && biometryAvailable && hasSavedCreds;
  const BiometricIcon = biometricUsesFaceIcon ? ScanFace : Fingerprint;

  const cardStyle: React.CSSProperties = isDark
    ? {
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(212,175,55,0.22)",
        boxShadow: "0 0 0 1px rgba(212,175,55,0.06), 0 8px 60px rgba(0,0,0,0.6), 0 0 80px rgba(212,175,55,0.05)",
        backdropFilter: "blur(16px)",
      }
    : {
        background: "rgba(255,255,255,0.94)",
        border: "1px solid rgba(212,175,55,0.18)",
        boxShadow: "0 4px 6px rgba(0,0,0,0.04), 0 12px 40px rgba(0,0,0,0.08), 0 0 0 1px rgba(212,175,55,0.06)",
        backdropFilter: "blur(8px)",
      };
  return {
    BiometricIcon,
    biometricLabel,
    biometryPending,
    cardStyle,
    handleDeclineBiometrics,
    handleEnableBiometrics,
    handleLogin,
    handlePasskeyLogin,
    handleRegisterPasskey,
    handleSkipPasskey,
    hasSavedPasskey,
    isDark,
    loginMutation,
    passKeyPending,
    passkeyRegPending,
    passkeySupported,
    password,
    passwordInputRef,
    setPassword,
    setShowPassword,
    setUsername,
    showBioPrompt,
    showBiometricButton,
    showPasskeyRegister,
    showPassword,
    triggerBiometric,
    username,
  };
}
