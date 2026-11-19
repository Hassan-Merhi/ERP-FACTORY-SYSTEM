import { KeyRound, X } from "lucide-react";
import { clearBiometricCredentials, saveBiometricCredentials } from "@/lib/biometricCredentials";
import { BTN_BG, BTN_SHADOW, GOLD_LIGHT } from "./LoginIsPasskeySnoozed";
import { useLoginState } from "./LoginUseLoginState";
import { LoginSection } from "./LoginLoginSection";
import { LoginContent } from "./LoginContent";

export { clearBiometricCredentials, saveBiometricCredentials };

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
      <LoginContent />

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
