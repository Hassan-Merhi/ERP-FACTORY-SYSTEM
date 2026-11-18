// Extracted from ./Login.tsx to keep that module under the source-size cap.
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BTN_BG, BTN_SHADOW, GOLD, GOLD_DARK, GOLD_LIGHT } from "./LoginIsPasskeySnoozed";
import { useLoginState } from "./LoginUseLoginState";

export function LoginSection({
  BiometricIcon,
  biometricLabel,
  biometryPending,
  cardStyle,
  handleLogin,
  handlePasskeyLogin,
  hasSavedPasskey,
  isDark,
  loginMutation,
  passKeyPending,
  passkeySupported,
  password,
  passwordInputRef,
  setPassword,
  setShowPassword,
  setUsername,
  showBiometricButton,
  showPassword,
  triggerBiometric,
  username,
}: Pick<
  ReturnType<typeof useLoginState>,
  | "BiometricIcon"
  | "biometricLabel"
  | "biometryPending"
  | "cardStyle"
  | "handleLogin"
  | "handlePasskeyLogin"
  | "hasSavedPasskey"
  | "isDark"
  | "loginMutation"
  | "passKeyPending"
  | "passkeySupported"
  | "password"
  | "passwordInputRef"
  | "setPassword"
  | "setShowPassword"
  | "setUsername"
  | "showBiometricButton"
  | "showPassword"
  | "triggerBiometric"
  | "username"
>) {
  return (
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
                  className="focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-hidden"
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
                  className="pr-9 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-hidden"
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
  );
}
