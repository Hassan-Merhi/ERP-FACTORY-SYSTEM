// Extracted from ./useFactoryWorkerDetailModel.tsx to keep that module under the source-size cap.

export interface WorkerDetailTabSettings {
  workerDetailTabStatementEnabled?: boolean;
  workerDetailTabAdvancesEnabled?: boolean;
  workerDetailTabBalesEnabled?: boolean;
  workerDetailTabDocumentsEnabled?: boolean;
  workersTabAttendanceEnabled?: boolean;
}

export function isHandledGlobally(error: unknown): boolean {
  return typeof error === "object" && error !== null && "_handledGlobally" in error && Boolean(error._handledGlobally);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
