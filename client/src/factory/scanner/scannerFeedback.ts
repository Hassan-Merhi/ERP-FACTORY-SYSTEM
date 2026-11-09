/** UI-only scan feedback. Never treat a locally queued scan as confirmed. */
export type FactoryScanUiState = "confirmed" | "duplicate" | "rejected" | "queued" | "syncing" | "pending";
export function factoryScanStateLabel(state: FactoryScanUiState): string {
  switch (state) {
    case "confirmed": return "Server confirmed";
    case "duplicate": return "Already scanned";
    case "rejected": return "Rejected";
    case "syncing": return "Sending";
    case "queued":
    case "pending": return "Saved locally — pending";
  }
}
/** Only server receipts count as confirmed; retries must not produce new counts. */
export function factoryScanIsConfirmed(state: FactoryScanUiState): boolean {
  return state === "confirmed";
}
