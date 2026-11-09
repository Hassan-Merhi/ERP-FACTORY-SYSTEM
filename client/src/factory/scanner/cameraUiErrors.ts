/**
 * Presentation-only camera error messages. No decoder, scan transport,
 * permissions or offline queue behavior belongs in this helper.
 */
export function factoryCameraErrorMessage(
  error: unknown,
  fallback = "Camera unavailable. Try manual entry.",
): string {
  const name = error && typeof error === "object" && "name" in error
    ? String(error.name) : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera permission denied. Allow camera access in browser settings, then retry.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No compatible rear camera was found. You can enter a barcode manually.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Camera is already in use by another app. Close it and retry.";
  }
  return error instanceof Error ? error.message : fallback;
}
