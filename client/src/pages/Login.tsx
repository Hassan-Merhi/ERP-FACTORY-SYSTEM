import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, BarChart3, ShoppingCart, Boxes, Factory, ScanFace, Fingerprint, KeyRound, X } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, resetCsrfToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ThemeToggle } from "@/components/ThemeToggle";

// Set to true to re-enable passkey registration & login
const PASSKEY_ENABLED = false;

function passkeyStorageKey(username: string) {
  return `passkey_registered_${username}`;
}
function passkeySnoozeKey(username: string) {
  return `passkey_snoozed_${username}`;
}
function isPasskeySnoozed(username: string) {
  const ts = localStorage.getItem(passkeySnoozeKey(username));
  if (!ts) return false;
  return Date.now() - parseInt(ts, 10) < 30 * 24 * 60 * 60 * 1000;
}

const CRED_KEY = "biometric_creds";
const OPT_IN_KEY = "biometric_opted_in";

async function loadNativePreferences() {
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
async function loadBiometricCredentials(): Promise<{ username: string; password: string } | null> {
  const Preferences = await loadNativePreferences();
  const { value } = await Preferences.get({ key: CRED_KEY });
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const features = [
  { icon: Boxes, title: "Inventory Management", description: "Real-time stock tracking across all locations" },
  { icon: ShoppingCart, title: "Point of Sale", description: "Fast, reliable checkout for every team" },
  { icon: Factory, title: "Factory Production", description: "Attendance, payroll, and batch output" },
  { icon: BarChart3, title: "Business Analytics", description: "Live reports to drive smarter decisions" },
];

const GOLD = "#D4AF37";
const GOLD_LIGHT = "#F5C542";
const GOLD_DARK = "#8A6E20";
const BTN_BG = `linear-gradient(135deg, ${GOLD_DARK} 0%, ${GOLD_LIGHT} 50%, ${GOLD_DARK} 100%)`;
const BTN_SHADOW = "0 4px 24px rgba(212,175,55,0.38)";

export default function Login() {
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
          navigate("/");
        } else if (optIn === "no") {
          queryClient.setQueryData(["/api/auth/me"], userData);
          resetCsrfToken();
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
          window.location.href = "/";
        } else {
          pendingUserData.current = userData;
          pendingPasskeyUser.current = credentials.username;
          setShowPasskeyRegister(true);
        }
      } else {
        resetCsrfToken();
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

  const triggerBiometric = useCallback(async (creds?: { username: string; password: string }) => {
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
        toast({ title: "Biometric failed", description: "Please sign in with your password.", variant: "destructive" });
      }
    } finally {
      setBiometryPending(false);
    }
  }, [loginMutation, toast]);

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
      window.location.href = "/";
    }
  };

  const handleSkipPasskey = () => {
    localStorage.setItem(passkeySnoozeKey(pendingPasskeyUser.current), String(Date.now()));
    setShowPasskeyRegister(false);
    resetCsrfToken();
    pendingUserData.current = null;
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

  return (
    <div className="flex min-h-screen min-h-[100dvh] flex-col xl:flex-row">
      {/* ══════════════════════════════════════════
          LEFT — Always-dark branding panel (desktop)
      ══════════════════════════════════════════ */}
      <div
        className="hidden xl:flex xl:w-[46%] shrink-0 flex-col justify-between px-12 py-10 relative overflow-hidden"
        style={{ background: "linear-gradient(155deg, #050505 0%, #0C0900 25%, #0D0D0D 60%, #080810 100%)" }}
      >
        {/* Ambient glows — richer layered */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: "radial-gradient(ellipse 100% 55% at 50% 0%, rgba(212,175,55,0.16) 0%, transparent 65%)",
          }}
        />
        <div
          className="pointer-events-none absolute top-1/3 -left-24 w-[28rem] h-[28rem] rounded-full"
          style={{ background: "rgba(212,175,55,0.055)", filter: "blur(70px)" }}
        />
        <div
          className="pointer-events-none absolute -bottom-20 right-8 w-80 h-80 rounded-full"
          style={{ background: "rgba(212,175,55,0.04)", filter: "blur(55px)" }}
        />
        <div
          className="pointer-events-none absolute top-16 right-4 w-52 h-52 rounded-full"
          style={{ background: "rgba(212,175,55,0.04)", filter: "blur(45px)" }}
        />
        {/* Subtle grid / noise texture */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.015]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 40px, rgba(212,175,55,1) 40px, rgba(212,175,55,1) 41px), repeating-linear-gradient(90deg, transparent, transparent 40px, rgba(212,175,55,1) 40px, rgba(212,175,55,1) 41px)",
          }}
        />

        {/* ── Logo with enhanced glow halo ── */}
        <div className="relative z-10 flex flex-col items-start gap-5">
          <div className="relative">
            {/* Outer diffuse halo */}
            <div
              className="absolute -inset-8 rounded-full"
              style={{
                background: "radial-gradient(circle, rgba(212,175,55,0.20) 0%, transparent 70%)",
                filter: "blur(22px)",
              }}
            />
            {/* Inner warm circle */}
            <div
              className="absolute inset-0 rounded-full"
              style={{ background: "radial-gradient(circle, rgba(212,175,55,0.12) 0%, transparent 80%)" }}
            />
            <img
              src="/hmd-logo-new.jpeg"
              alt="HMD International Group"
              className="relative w-44 h-auto object-contain rounded-full"
              style={{ mixBlendMode: "screen", filter: "drop-shadow(0 0 18px rgba(212,175,55,0.30))" }}
            />
          </div>
          <div
            className="w-32 h-px"
            style={{ background: "linear-gradient(90deg, rgba(212,175,55,0.7) 0%, transparent 100%)" }}
          />
        </div>

        {/* ── Headline + features ── */}
        <div className="relative z-10 space-y-8">
          <div className="space-y-3">
            <h2
              className="text-[2.15rem] font-extrabold leading-tight tracking-tight"
              style={{ color: GOLD_LIGHT, textShadow: "0 0 40px rgba(245,197,66,0.25)" }}
            >
              Run your business
              <br />
              with confidence.
            </h2>
            <div
              className="w-9 h-[2px] rounded-full"
              style={{ background: `linear-gradient(90deg, ${GOLD} 0%, transparent 100%)` }}
            />
            <p className="text-sm leading-relaxed max-w-xs" style={{ color: "rgba(245,197,66,0.52)" }}>
              Production, inventory, payroll, invoices, and reporting — all in one unified platform.
            </p>
          </div>

          {/* Feature cards — modern with hover */}
          <div className="space-y-2">
            {features.map((f) => (
              <div
                key={f.title}
                className="group flex items-center gap-3.5 px-3.5 py-3 rounded-xl cursor-default"
                style={{
                  background: "rgba(255,255,255,0.02)",
                  border: "1px solid rgba(212,175,55,0.10)",
                  transition: "background 0.18s ease, border-color 0.18s ease",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "rgba(212,175,55,0.07)";
                  (e.currentTarget as HTMLElement).style.borderColor = "rgba(212,175,55,0.22)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)";
                  (e.currentTarget as HTMLElement).style.borderColor = "rgba(212,175,55,0.10)";
                }}
              >
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    background: "rgba(212,175,55,0.10)",
                    border: "1px solid rgba(212,175,55,0.22)",
                    boxShadow: "0 0 12px rgba(212,175,55,0.08)",
                  }}
                >
                  <f.icon className="h-[15px] w-[15px]" style={{ color: GOLD }} />
                </div>
                <div>
                  <p className="font-semibold text-[0.8rem] leading-tight" style={{ color: "#F2E8C0" }}>
                    {f.title}
                  </p>
                  <p className="text-[0.71rem] leading-tight mt-0.5" style={{ color: "rgba(212,175,55,0.43)" }}>
                    {f.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Copyright — readable warm gold */}
        <p className="relative z-10 text-[0.68rem]" style={{ color: "rgba(212,175,55,0.38)" }}>
          &copy; {new Date().getFullYear()} HMD International Group. All rights reserved.
        </p>
      </div>

      {/* ══════════════════════════════════════════
          RIGHT — Premium themed panel
      ══════════════════════════════════════════ */}
      <div className="flex flex-1 flex-col relative overflow-hidden bg-[#F8F3E7] dark:bg-[#090909]">
        {/* Light mode: warm champagne center radial */}
        <div
          className="pointer-events-none absolute inset-0 dark:hidden"
          style={{
            background: "radial-gradient(ellipse 80% 70% at 50% 45%, rgba(212,175,55,0.07) 0%, transparent 65%)",
          }}
        />
        {/* Light mode: subtle warm vignette */}
        <div
          className="pointer-events-none absolute inset-0 dark:hidden"
          style={{
            background: "radial-gradient(ellipse 110% 110% at 50% 110%, rgba(180,140,20,0.06) 0%, transparent 55%)",
          }}
        />

        {/* Dark mode: deep gold ambient at bottom */}
        <div
          className="pointer-events-none absolute inset-0 hidden dark:block"
          style={{
            background: "radial-gradient(ellipse 90% 55% at 50% 100%, rgba(212,175,55,0.08) 0%, transparent 60%)",
          }}
        />
        {/* Dark mode: top-right subtle accent */}
        <div
          className="pointer-events-none absolute inset-0 hidden dark:block"
          style={{
            background: "radial-gradient(ellipse 55% 40% at 85% 10%, rgba(212,175,55,0.05) 0%, transparent 60%)",
          }}
        />

        {/* Gold top stripe */}
        <div
          className="absolute top-0 left-0 right-0 h-[2px] z-10"
          style={{ background: `linear-gradient(90deg, ${GOLD_DARK}, ${GOLD_LIGHT} 50%, ${GOLD_DARK})` }}
        />

        {/* ── MOBILE BRANDING ── */}
        <div className="xl:hidden flex flex-col items-center pt-14 pb-6 px-6">
          <div
            className="w-20 h-20 rounded-full overflow-hidden mb-4"
            style={{
              background: "#0D0D0D",
              boxShadow: `0 0 0 2px rgba(212,175,55,0.35), 0 0 20px rgba(212,175,55,0.15), 0 4px 20px rgba(0,0,0,0.3)`,
            }}
          >
            <img src="/hmd-logo-new.jpeg" alt="HMD International Group" className="w-full h-full object-cover" />
          </div>
          <h1 className="text-base font-bold text-foreground tracking-tight">HMD International Group</h1>
          <p className="text-[0.7rem] text-muted-foreground tracking-widest uppercase mt-0.5">ERP &amp; POS Platform</p>
        </div>

        {/* Theme toggle */}
        <div className="absolute top-4 right-4 z-20">
          <ThemeToggle />
        </div>

        {/* ── FORM inside premium card ── */}
        <div className="relative z-10 flex flex-1 items-center justify-center px-4 sm:px-6 py-8 xl:py-10">
          <div className="w-full max-w-[400px] rounded-2xl p-7 sm:p-9 space-y-5" style={cardStyle}>
            {/* Heading */}
            <div className="space-y-1">
              <p
                className="hidden xl:block text-[0.58rem] font-bold tracking-[0.3em] uppercase"
                style={{ color: isDark ? "rgba(212,175,55,0.5)" : "rgba(139,100,20,0.55)" }}
              >
                HMD International Group
              </p>
              <h2 className="text-[1.55rem] font-bold text-foreground tracking-tight">Welcome back</h2>
              <p className="text-sm text-muted-foreground">Sign in to continue to your account</p>
            </div>

            {/* Gold accent divider */}
            <div
              className="h-px w-full"
              style={{
                background: isDark
                  ? `linear-gradient(90deg, rgba(212,175,55,0.45) 0%, rgba(212,175,55,0.15) 50%, transparent 100%)`
                  : `linear-gradient(90deg, rgba(212,175,55,0.4) 0%, rgba(212,175,55,0.12) 50%, transparent 100%)`,
              }}
            />

            {/* Biometric quick-sign-in */}
            {showBiometricButton && (
              <button
                type="button"
                onClick={() => triggerBiometric()}
                disabled={biometryPending || loginMutation.isPending}
                data-testid="button-biometric-login"
                className="w-full h-11 rounded-xl font-semibold text-sm flex items-center justify-center gap-2.5 disabled:opacity-60 transition-opacity"
                style={{
                  background: isDark ? "rgba(212,175,55,0.08)" : "rgba(212,175,55,0.10)",
                  border: `1px solid rgba(212,175,55,0.30)`,
                  color: GOLD_LIGHT,
                }}
              >
                <BiometricIcon className="h-4.5 w-4.5" />
                {biometryPending ? "Verifying…" : `Sign in with ${biometricLabel}`}
              </button>
            )}

            {/* Form */}
            <form onSubmit={handleLogin} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="username" className="text-[0.8rem] font-medium text-foreground">
                  Username
                </Label>
                <div
                  className="rounded-lg transition-shadow duration-150"
                  style={{}}
                  onFocusCapture={(e) => {
                    (e.currentTarget as HTMLElement).style.boxShadow = `0 0 0 2px rgba(212,175,55,0.35)`;
                  }}
                  onBlurCapture={(e) => {
                    (e.currentTarget as HTMLElement).style.boxShadow = "none";
                  }}
                >
                  <Input
                    id="username"
                    type="text"
                    placeholder="Enter your username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    data-testid="input-username"
                    autoComplete="username"
                    className="focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-[0.8rem] font-medium text-foreground">
                  Password
                </Label>
                <div
                  className="relative rounded-lg transition-shadow duration-150"
                  onFocusCapture={(e) => {
                    (e.currentTarget as HTMLElement).style.boxShadow = `0 0 0 2px rgba(212,175,55,0.35)`;
                  }}
                  onBlurCapture={(e) => {
                    (e.currentTarget as HTMLElement).style.boxShadow = "none";
                  }}
                >
                  <Input
                    ref={passwordInputRef}
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                      e.preventDefault();
                      if (!loginMutation.isPending && !biometryPending) {
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                    data-testid="input-password"
                    autoComplete="current-password"
                    className="pr-9 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    data-testid="button-toggle-password"
                    tabIndex={-1}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showPassword ? <EyeOff className="h-[15px] w-[15px]" /> : <Eye className="h-[15px] w-[15px]" />}
                  </button>
                </div>
              </div>

              {/* Sign In button — gold gradient */}
              <button
                type="submit"
                data-testid="button-login"
                disabled={loginMutation.isPending || biometryPending}
                className="w-full h-11 rounded-xl font-bold text-[0.9rem] text-black disabled:opacity-60 mt-1"
                style={{
                  background: BTN_BG,
                  boxShadow: BTN_SHADOW,
                  transition: "opacity 0.15s, transform 0.1s, box-shadow 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.boxShadow = "0 6px 30px rgba(212,175,55,0.50)";
                  (e.currentTarget as HTMLElement).style.opacity = "0.93";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.boxShadow = BTN_SHADOW;
                  (e.currentTarget as HTMLElement).style.opacity = "1";
                }}
                onMouseDown={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = "scale(0.988)";
                }}
                onMouseUp={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = "scale(1)";
                }}
              >
                {loginMutation.isPending ? "Signing in…" : "Sign In"}
              </button>

              {hasSavedPasskey && passkeySupported && (
                <button
                  type="button"
                  onClick={handlePasskeyLogin}
                  disabled={passKeyPending || loginMutation.isPending}
                  data-testid="button-passkey-login"
                  className="w-full flex items-center justify-center gap-2 text-xs font-medium py-2 rounded-xl disabled:opacity-50 transition-opacity"
                  style={{
                    color: GOLD,
                    background: isDark ? "rgba(212,175,55,0.06)" : "rgba(212,175,55,0.08)",
                    border: `1px solid rgba(212,175,55,0.22)`,
                  }}
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  {passKeyPending ? "Verifying…" : "Sign in with saved passkey"}
                </button>
              )}
            </form>

            {/* Footer */}
            <p
              className="text-center text-[0.64rem] pt-1"
              style={{ color: isDark ? "rgba(212,175,55,0.30)" : "rgba(139,100,20,0.45)" }}
            >
              HMD International Group &mdash; ERP &amp; POS Platform
            </p>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          PASSKEY REGISTER PROMPT (web only)
      ══════════════════════════════════════════ */}
      {showPasskeyRegister && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-6 sm:pb-0"
          style={{ background: "rgba(0,0,0,0.70)", backdropFilter: "blur(8px)" }}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-6 space-y-5 relative"
            style={{
              background: "rgba(12,12,18,0.97)",
              border: `1px solid rgba(212,175,55,0.26)`,
              boxShadow: "0 0 0 1px rgba(212,175,55,0.06), 0 24px 64px rgba(0,0,0,0.75)",
            }}
          >
            <button
              className="absolute top-4 right-4 text-muted-foreground opacity-60 hover:opacity-100 transition-opacity"
              onClick={handleSkipPasskey}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="flex flex-col items-center text-center gap-3 pt-1">
              <div
                className="flex h-14 w-14 items-center justify-center rounded-full"
                style={{ background: "rgba(212,175,55,0.12)", border: `1px solid rgba(212,175,55,0.28)` }}
              >
                <KeyRound className="h-7 w-7" style={{ color: GOLD_LIGHT }} />
              </div>
              <div>
                <p className="font-bold text-base" style={{ color: "#f0e6c8" }}>
                  Save a Passkey?
                </p>
                <p className="text-xs mt-1" style={{ color: "rgba(212,175,55,0.50)" }}>
                  Sign in instantly next time using Face ID, Touch ID, or your device passkey — no password needed.
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={handleRegisterPasskey}
                disabled={passkeyRegPending}
                data-testid="button-save-passkey"
                className="w-full h-11 rounded-xl font-bold text-sm text-black disabled:opacity-60"
                style={{ background: BTN_BG, boxShadow: BTN_SHADOW }}
              >
                {passkeyRegPending ? "Setting up…" : "Save Passkey"}
              </button>
              <button
                onClick={handleSkipPasskey}
                data-testid="button-skip-passkey"
                className="w-full h-10 rounded-xl font-semibold text-xs"
                style={{ color: "rgba(212,175,55,0.48)", background: "transparent" }}
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════
          BIOMETRIC OPT-IN PROMPT (native only)
      ══════════════════════════════════════════ */}
      {showBioPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-6 sm:pb-0"
          style={{ background: "rgba(0,0,0,0.70)", backdropFilter: "blur(8px)" }}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-6 space-y-5 relative"
            style={{
              background: "rgba(12,12,18,0.97)",
              border: `1px solid rgba(212,175,55,0.26)`,
              boxShadow: "0 0 0 1px rgba(212,175,55,0.06), 0 24px 64px rgba(0,0,0,0.75)",
            }}
          >
            <button
              className="absolute top-4 right-4 text-muted-foreground opacity-60 hover:opacity-100 transition-opacity"
              onClick={handleDeclineBiometrics}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="flex flex-col items-center text-center gap-3 pt-1">
              <div
                className="flex h-14 w-14 items-center justify-center rounded-full"
                style={{ background: "rgba(212,175,55,0.12)", border: `1px solid rgba(212,175,55,0.28)` }}
              >
                <BiometricIcon className="h-7 w-7" style={{ color: GOLD_LIGHT }} />
              </div>
              <div>
                <p className="font-bold text-base" style={{ color: "#f0e6c8" }}>
                  Enable {biometricLabel}?
                </p>
                <p className="text-xs mt-1" style={{ color: "rgba(212,175,55,0.50)" }}>
                  Sign in instantly next time using {biometricLabel} instead of your password.
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={handleEnableBiometrics}
                data-testid="button-enable-biometrics"
                className="w-full h-11 rounded-xl font-bold text-sm text-black"
                style={{ background: BTN_BG, boxShadow: BTN_SHADOW }}
              >
                Enable {biometricLabel}
              </button>
              <button
                onClick={handleDeclineBiometrics}
                data-testid="button-decline-biometrics"
                className="w-full h-10 rounded-xl font-semibold text-xs"
                style={{ color: "rgba(212,175,55,0.48)", background: "transparent" }}
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
