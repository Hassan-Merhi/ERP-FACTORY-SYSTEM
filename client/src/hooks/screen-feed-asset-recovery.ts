/**
 * A caught lazy-import failure does not reach main.tsx's unhandledrejection
 * listener. Forward only genuine module loading errors to the shared
 * stale-asset recovery path; rendering/runtime errors must not reload the ERP.
 */
export function isScreenFeedModuleLoadFailure(error: unknown): boolean {
  if (!error) return false;
  const failure = error as { name?: unknown; message?: unknown };
  const name = String(failure.name ?? "");
  if (name === "AbortError" || name === "CancelledError") return false;
  const message = typeof error === "string" ? error : String(failure.message ?? "");
  return (
    name === "ChunkLoadError" ||
    /failed to fetch dynamically imported module|importing a module script failed|loading chunk|chunkloaderror|unable to preload css|failed to load module script/i.test(
      message
    )
  );
}

export function reportScreenFeedModuleLoadFailure(error: unknown): void {
  if (!isScreenFeedModuleLoadFailure(error)) return;
  window.dispatchEvent(new Event("erp:screen-feed-module-load-failed"));
}
