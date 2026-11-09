import { Component, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";

interface Props {
  children: ReactNode;
  resetKey?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  lastResetKey?: string;
  isChunkError: boolean;
}

// Check every possible place the chunk error text might live.
// IMPORTANT: Only match genuine network-level chunk loading failures.
// Do NOT match based on stack trace paths — production JS files have hashed
// names like /assets/Foo-ABC123.js which appear in ALL stack traces, causing
// real runtime errors to be misclassified as chunk errors and triggering
// an infinite "New version available" reload loop.
function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const candidates: string[] = [];
  if (typeof error === "string") {
    candidates.push(error);
  } else if (error && typeof error === "object") {
    const e = error as { message?: unknown; name?: unknown; toString?: () => string };
    if (e.message) candidates.push(String(e.message));
    if (e.name) candidates.push(String(e.name));
    try {
      if (typeof e.toString === "function") candidates.push(e.toString());
    } catch {
      /* ignore */
    }
  }
  const combined = candidates.join(" ");
  return (
    combined.includes("dynamically imported module") ||
    combined.includes("Loading chunk") ||
    combined.includes("Importing a module script failed") ||
    combined.includes("Unable to preload CSS") ||
    combined.includes("ChunkLoadError") ||
    combined.includes("Page module loading timed out") ||
    (error as { name: "ChunkLoadError" })?.name === "ChunkLoadError"
  );
}

// Hard navigation — forces the browser to re-fetch HTML + new chunk URLs.
function hardNavigate(path: string) {
  window.location.href = path + (path.includes("?") ? "&" : "?") + "_r=" + Date.now();
}

const RETRY_WINDOW_MS = 30_000; // 30s sliding window
const MAX_RETRIES = 2;

function getRetryState(path: string): { count: number; firstAt: number } {
  try {
    const raw = sessionStorage.getItem("chunkRetry:" + path);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { count: 0, firstAt: 0 };
}

function recordRetry(path: string) {
  try {
    const now = Date.now();
    const state = getRetryState(path);
    // Reset window if it's been long enough
    const base = now - state.firstAt < RETRY_WINDOW_MS ? state : { count: 0, firstAt: now };
    sessionStorage.setItem(
      "chunkRetry:" + path,
      JSON.stringify({
        count: base.count + 1,
        firstAt: base.count === 0 ? now : state.firstAt,
      })
    );
  } catch {
    /* ignore */
  }
}

function clearRetries(path: string) {
  try {
    sessionStorage.removeItem("chunkRetry:" + path);
  } catch {
    /* ignore */
  }
}

function canAutoRetry(path: string): boolean {
  const { count, firstAt } = getRetryState(path);
  const withinWindow = Date.now() - firstAt < RETRY_WINDOW_MS;
  return count < MAX_RETRIES && (count === 0 || withinWindow);
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      lastResetKey: props.resetKey,
      isChunkError: false,
    };
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    const isChunk = isChunkLoadError(error);
    let normalized: Error;
    if (error instanceof Error) {
      normalized = error;
    } else {
      const errorLike =
        error && typeof error === "object" ? (error as { message?: unknown; stack?: unknown }) : null;
      const message = typeof errorLike?.message === "string" ? errorLike.message : "";
      const stackFirstLine =
        typeof errorLike?.stack === "string" ? errorLike.stack.split("\n")[0] ?? "" : "";
      normalized = new Error(message || stackFirstLine || String(error) || "Unknown error");
    }
    return { hasError: true, error: normalized, isChunkError: isChunk };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.lastResetKey) {
      return {
        hasError: false,
        error: null,
        lastResetKey: props.resetKey,
        isChunkError: false,
      };
    }
    return null;
  }

  componentDidCatch(error: unknown, info: { componentStack: string }) {
    console.error("[ErrorBoundary] Uncaught error:", error, info.componentStack);

    if (isChunkLoadError(error)) {
      // In development, Vite HMR handles reconnection — never auto-reload here.
      // Auto-reloading fights Vite's own recovery and creates a loop on every
      // dev server restart.
      if (import.meta.env.DEV) return;

      // If we're offline, the chunk simply isn't cached — reloading won't help.
      if (!navigator.onLine) return;
      // Missing hashed chunks after a deployment require cache/SW recovery,
      // not simply another navigation to the same unavailable asset.
      window.dispatchEvent(new CustomEvent("erp:asset-load-failed"));
      return;
    }
  }

  handleReload = () => {
    clearRetries(window.location.pathname);
    hardNavigate(window.location.pathname);
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null, isChunkError: false });
  };

  render() {
    if (this.state.hasError) {
      const isChunk = this.state.isChunkError || isChunkLoadError(this.state.error);

      if (isChunk) {
        // When offline, the chunk simply isn't cached yet — reload won't help.
        const isOffline = !navigator.onLine;
        if (isOffline) {
          return (
            <div className="flex flex-col items-center justify-center h-full min-h-[40vh] gap-4 p-6 text-center">
              <WifiOff className="h-10 w-10 text-muted-foreground" />
              <div>
                <p className="font-semibold text-lg">Page not available offline</p>
                <p className="text-sm text-muted-foreground mt-1">
                  This page hasn't been cached yet. Visit it while connected, or run "Prepare for offline" again to
                  download all pages.
                </p>
              </div>
              <Button variant="outline" onClick={() => window.history.back()} data-testid="button-go-back-offline">
                Go back
              </Button>
            </div>
          );
        }
        // In development the server restarts often — don't alarm the user with
        // "New version available". Just show a quiet reload prompt.
        const isDev = import.meta.env.DEV;
        return (
          <div className="flex flex-col items-center justify-center h-full min-h-[40vh] gap-4 p-6 text-center">
            <RefreshCw className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-semibold text-lg">{isDev ? "Page needs a reload" : "New version available"}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {isDev
                  ? "The dev server restarted. Click below to reload this page."
                  : "The app was updated. Click below to reload and get the latest version."}
              </p>
            </div>
            <Button onClick={this.handleReload} data-testid="button-reload-chunk">
              Reload page
            </Button>
          </div>
        );
      }

      return (
        <div className="flex flex-col items-center justify-center h-full min-h-[40vh] gap-4 p-6 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive" />
          <div>
            <p className="font-semibold text-lg">Something went wrong on this page</p>
            <p className="text-sm text-muted-foreground mt-1">
              {this.state.error?.message || "An unexpected error occurred"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={this.handleReset} data-testid="button-try-again">
              Try again
            </Button>
            <Button variant="ghost" onClick={() => window.history.back()} data-testid="button-go-back">
              Go back
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
