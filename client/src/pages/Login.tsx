import { BarChart3, ShoppingCart, Boxes, Factory, KeyRound, X } from "lucide-react";
import { clearBiometricCredentials, saveBiometricCredentials } from "@/lib/biometricCredentials";
import { BTN_BG, BTN_SHADOW, GOLD, GOLD_LIGHT } from "./LoginIsPasskeySnoozed";
import { useLoginState } from "./LoginUseLoginState";
import { LoginSection } from "./LoginLoginSection";

export { clearBiometricCredentials, saveBiometricCredentials };

const features = [
  { icon: Boxes, title: "Inventory Management", description: "Real-time stock tracking across all locations" },
  { icon: ShoppingCart, title: "Point of Sale", description: "Fast, reliable checkout for every team" },
  { icon: Factory, title: "Factory Production", description: "Attendance, payroll, and batch output" },
  { icon: BarChart3, title: "Business Analytics", description: "Live reports to drive smarter decisions" },
];

export default function Login() {
  const {
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
  } = useLoginState();

  return (
    <div className="flex min-h-screen min-h-dvh flex-col xl:flex-row">
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
          className="pointer-events-none absolute top-1/3 -left-24 w-md h-112 rounded-full"
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
      <LoginSection
        BiometricIcon={BiometricIcon}
        biometricLabel={biometricLabel}
        biometryPending={biometryPending}
        cardStyle={cardStyle}
        handleLogin={handleLogin}
        handlePasskeyLogin={handlePasskeyLogin}
        hasSavedPasskey={hasSavedPasskey}
        isDark={isDark}
        loginMutation={loginMutation}
        passKeyPending={passKeyPending}
        passkeySupported={passkeySupported}
        password={password}
        passwordInputRef={passwordInputRef}
        setPassword={setPassword}
        setShowPassword={setShowPassword}
        setUsername={setUsername}
        showBiometricButton={showBiometricButton}
        showPassword={showPassword}
        triggerBiometric={triggerBiometric}
        username={username}
      />

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
