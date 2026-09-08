import { randomUUID } from "node:crypto";
import {
  createTemporaryExportArchive,
  releaseTemporaryExportArchive,
  type TemporaryExportArchiveResult,
} from "./temporaryExportArchive";
import type { ExportAttachmentSource } from "./exportAttachmentSource";
import type { ExportCompany } from "./buildFullExportZip";

export interface ScheduledExportArtifact {
  attachment: ExportAttachmentSource;
  filePath: string;
  sizeBytes: number;
  names: string[];
  skipped: string[];
  dispose: () => Promise<void>;
}

export async function createScheduledExportArtifact(
  label: string,
  companies: readonly ExportCompany[],
  fromDate?: string,
  toDate?: string,
  onProgress?: (msg: string, level?: "info" | "success" | "warning" | "error") => void
): Promise<ScheduledExportArtifact> {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
  const jobId = `scheduled-${safeLabel}-${randomUUID()}`;
  const archive: TemporaryExportArchiveResult = await createTemporaryExportArchive(
    jobId,
    companies,
    fromDate,
    toDate,
    onProgress
  );

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await releaseTemporaryExportArchive(archive.filePath);
  };

  return {
    attachment: { filePath: archive.filePath, sizeBytes: archive.bytesWritten },
    filePath: archive.filePath,
    sizeBytes: archive.bytesWritten,
    names: archive.names,
    skipped: archive.skipped,
    dispose,
  };
}

export async function withScheduledExportArtifact<T>(
  label: string,
  companies: readonly ExportCompany[],
  fromDate: string | undefined,
  toDate: string | undefined,
  work: (artifact: ScheduledExportArtifact) => Promise<T>,
  onProgress?: (msg: string, level?: "info" | "success" | "warning" | "error") => void
): Promise<T> {
  const artifact = await createScheduledExportArtifact(label, companies, fromDate, toDate, onProgress);
  try {
    return await work(artifact);
  } finally {
    await artifact.dispose();
  }
}
