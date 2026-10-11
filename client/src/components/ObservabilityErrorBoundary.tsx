import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "@/lib/clientObservability";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ObservabilityErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError({
      source: "react_error_boundary",
      message: error.message || "React render error",
      stack: error.stack,
      componentStack: info.componentStack || undefined,
    });
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-md rounded-lg border bg-card p-6 text-center shadow-xs" role="alert">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The error was recorded. Refresh the application to continue.
          </p>
          <button
            type="button"
            className="mt-5 min-h-11 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            Refresh application
          </button>
        </section>
      </main>
    );
  }
}
