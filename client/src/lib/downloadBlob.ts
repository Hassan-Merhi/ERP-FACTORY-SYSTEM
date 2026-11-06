/**
 * Start a browser download with a real anchor activation. iOS Safari may read
 * the blob URL on the next turn of its event loop (or when the Files sheet
 * appears); immediate URL.revokeObjectURL can leave a blank/corrupt download.
 *
 * Call this from the existing user-initiated export workflow. This does not
 * change export contents or invoke the Web Share API, whose user-activation
 * requirement is usually lost during asynchronous Excel workbook creation.
 */
export const BLOB_DOWNLOAD_GRACE_MS = 60_000;

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  let link: HTMLAnchorElement | null = null;
  try {
    link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    // WebKit is more reliable when the anchor is in the document at click time.
    document.body.appendChild(link);
    link.click();
  } finally {
    link?.remove();
    // Do not revoke immediately: iOS Safari may resolve the blob URL after
    // dispatch, especially for files opened through the native Files sheet.
    window.setTimeout(() => URL.revokeObjectURL(url), BLOB_DOWNLOAD_GRACE_MS);
  }
}
