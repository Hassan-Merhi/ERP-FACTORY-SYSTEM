import { ZipArchive } from "archiver";
import type { Archiver } from "archiver";
import type { Writable } from "stream";
import { streamCompanyWorkbookDirect } from "../services/export-excel";
import { logger } from "../lib/logger";
import { withHeavyExportSlot } from "../services/heavyExportCoordinator";
import { getExportAttachmentSize } from "./exportAttachmentSource";

export interface ExportZipResult {
  zip: Buffer;
  names: string[];
  skipped: string[];
}

export interface StreamExportZipResult {
  names: string[];
  skipped: string[];
  bytesWritten: number;
}

type ExportProgress = (msg: string, level?: "info" | "success" | "warning" | "error") => void;
type ExportArchive = Archiver;

function createProgressLogger(onProgress?: ExportProgress): ExportProgress {
  return (
    onProgress ??
    ((message: string, level: "info" | "success" | "warning" | "error" = "info") => {
      const context = { module: "full-export", action: "build-zip" };
      if (level === "error") logger.error(message, context);
      else if (level === "warning") logger.warn(message, context);
      else logger.info(message, context);
    })
  );
}

/**
 * The only company fields this exporter reads: the id it fetches a workbook
 * for, and the name it uses for the ZIP entry and the progress log. Callers
 * pass full company rows, which satisfy this structurally.
 */
export interface ExportCompany {
  id: number;
  name: string;
}

function attachArchiveLogging(arc: ExportArchive): void {
  arc.on("warning", (error: unknown) => {
    logger.warn("Export ZIP archiver warning", {
      module: "full-export",
      action: "archive",
      error,
    });
  });
}

async function appendCompanyWorkbooks(
  arc: ExportArchive,
  companies: readonly ExportCompany[],
  fromDate: string | undefined,
  toDate: string | undefined,
  log: ExportProgress
): Promise<{ names: string[]; skipped: string[] }> {
  const dateLabel = new Date().toISOString().substring(0, 10);
  const names: string[] = [];
  const skipped: string[] = [];

  for (const company of companies) {
    try {
      log(`[${company.name}] Building workbook one sheet at a time...`, "info");

      const safeName = company.name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim();
      const entryName = `${safeName}_Export_${dateLabel}.xlsx`;

      // ExcelJS's document workbook still creates one workbook buffer. Append it
      // immediately, then release the reference before starting the next company.
      // The surrounding ZIP is streamed and is never accumulated in Buffer[].
      const xlsBuf = await streamCompanyWorkbookDirect(company.id, fromDate, toDate);
      arc.append(xlsBuf, { name: entryName });

      names.push(company.name);
      log(`[${company.name}] workbook appended to ZIP`, "success");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[${company.name}] Failed: ${message}`, "error");
      logger.error("Company workbook export failed", {
        module: "full-export",
        action: "company-workbook",
        companyId: company.id,
        companyName: company.name,
        error,
      });
      skipped.push(company.name);
    }
  }

  if (names.length === 0) {
    arc.abort();
    const message = `Export aborted — all ${companies.length} company/companies failed to generate workbooks. ZIP would be empty. Check server logs for per-company errors.`;
    log(message, "error");
    throw new Error(message);
  }

  return { names, skipped };
}

async function streamFullExportZipUnsafe(
  destination: Writable,
  companies: readonly ExportCompany[],
  fromDate?: string,
  toDate?: string,
  onProgress?: ExportProgress
): Promise<StreamExportZipResult> {
  const log = createProgressLogger(onProgress);
  const arc = new ZipArchive({ zlib: { level: 6 } });
  attachArchiveLogging(arc);

  const complete = new Promise<void>((resolve, reject) => {
    destination.once("finish", resolve);
    destination.once("error", reject);
    destination.once("close", () => {
      if (!destination.writableFinished) reject(new Error("Export destination closed before completion"));
    });
    arc.once("error", reject);
  });

  arc.pipe(destination);

  try {
    const { names, skipped } = await appendCompanyWorkbooks(arc, companies, fromDate, toDate, log);
    await arc.finalize();
    await complete;

    const bytesWritten = arc.pointer();
    log(
      `ZIP streamed — ${(bytesWritten / 1024 / 1024).toFixed(1)} MB (${names.length} companies, ${skipped.length} skipped)`,
      "success"
    );

    return { names, skipped, bytesWritten };
  } catch (error) {
    try {
      arc.abort();
    } catch {
      // Best effort; the original error remains authoritative.
    }
    if (!destination.destroyed) destination.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    arc.removeAllListeners();
  }
}

/**
 * Direct-download path. The ZIP bytes flow from archiver to the HTTP response or
 * another Writable and are never retained as Buffer chunks in Node memory.
 * All callers share the global heavy-export slot to prevent overlapping builds.
 */
export async function streamFullExportZip(
  destination: Writable,
  companies: readonly ExportCompany[],
  fromDate?: string,
  toDate?: string,
  onProgress?: ExportProgress
): Promise<StreamExportZipResult> {
  return withHeavyExportSlot("full-export-stream", () =>
    streamFullExportZipUnsafe(destination, companies, fromDate, toDate, onProgress)
  );
}

async function buildFullExportZipUnsafe(
  companies: readonly ExportCompany[],
  fromDate?: string,
  toDate?: string,
  onProgress?: ExportProgress
): Promise<ExportZipResult> {
  const log = createProgressLogger(onProgress);
  const chunks: Buffer[] = [];
  const arc = new ZipArchive({ zlib: { level: 6 } });
  attachArchiveLogging(arc);
  arc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const zipPromise = new Promise<Buffer>((resolve, reject) => {
    arc.on("end", () => resolve(Buffer.concat(chunks)));
    arc.on("error", reject);
  });

  try {
    const { names, skipped } = await appendCompanyWorkbooks(arc, companies, fromDate, toDate, log);
    await arc.finalize();
    const zip = await zipPromise;

    log(
      `ZIP ready — ${(getExportAttachmentSize(zip) / 1024 / 1024).toFixed(1)} MB (${names.length} companies, ${skipped.length} skipped)`,
      "success"
    );
    return { zip, names, skipped };
  } catch (error) {
    chunks.length = 0;
    try {
      arc.abort();
    } catch {
      // Best effort; the original error remains authoritative.
    }
    throw error;
  } finally {
    arc.removeAllListeners();
  }
}

/**
 * Attachment compatibility path used by email and WhatsApp providers, which
 * require final bytes. It is still serialized through the heavy-export slot.
 */
export async function buildFullExportZip(
  companies: readonly ExportCompany[],
  fromDate?: string,
  toDate?: string,
  onProgress?: ExportProgress
): Promise<ExportZipResult> {
  return withHeavyExportSlot("full-export-buffered", () =>
    buildFullExportZipUnsafe(companies, fromDate, toDate, onProgress)
  );
}
