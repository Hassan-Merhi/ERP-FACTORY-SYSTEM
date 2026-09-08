import fs from "fs";
import { logger } from "../lib/logger";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";
import type { Response } from "express";
import { type ExportCompany, streamFullExportZip, type StreamExportZipResult } from "./buildFullExportZip";

const EXPORT_FILE_PREFIX = "erp-export-";
const DEFAULT_STALE_ARCHIVE_AGE_MS = 60 * 60 * 1000;

export interface TemporaryExportArchiveResult extends StreamExportZipResult {
  filePath: string;
}

function safeJobId(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getStaleArchiveAgeMs(): number {
  const configured = Number(process.env.EXPORT_TEMP_FILE_MAX_AGE_MS);
  return Number.isFinite(configured) && configured >= 60_000 ? configured : DEFAULT_STALE_ARCHIVE_AGE_MS;
}

export async function cleanupStaleTemporaryExportArchives(
  nowMs = Date.now(),
  maxAgeMs = getStaleArchiveAgeMs()
): Promise<number> {
  const tempDir = os.tmpdir();
  let removed = 0;

  try {
    const entries = await fs.promises.readdir(tempDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.startsWith(EXPORT_FILE_PREFIX) || !entry.name.endsWith(".zip")) return;

        const filePath = path.join(tempDir, entry.name);
        try {
          const stat = await fs.promises.stat(filePath);
          if (nowMs - stat.mtimeMs < maxAgeMs) return;
          await fs.promises.rm(filePath, { force: true });
          removed += 1;
        } catch (error: unknown) {
          if ((error as { code?: string }).code !== "ENOENT") {
            logger.warn(`[ExportArchive] Failed to inspect or remove stale file ${filePath}:`, { error: error });
          }
        }
      })
    );
  } catch (error) {
    logger.warn("[ExportArchive] Startup stale-file cleanup failed:", { error: error });
  }

  if (removed > 0) {
    logger.info(`[ExportArchive] Removed ${removed} stale temporary archive(s).`);
  }
  return removed;
}

// Best-effort startup cleanup for archives left behind by a crash or hard restart.
// This promise is intentionally not awaited during module loading.
void cleanupStaleTemporaryExportArchives();

export async function createTemporaryExportArchive(
  jobId: string,
  companies: readonly ExportCompany[],
  fromDate?: string,
  toDate?: string,
  onProgress?: (msg: string, level?: "info" | "success" | "warning" | "error") => void
): Promise<TemporaryExportArchiveResult> {
  const filePath = path.join(os.tmpdir(), `${EXPORT_FILE_PREFIX}${safeJobId(jobId)}-${Date.now()}.zip`);
  const output = fs.createWriteStream(filePath, { flags: "wx" });

  try {
    const result = await streamFullExportZip(output, companies, fromDate, toDate, onProgress);
    if (!output.closed) {
      await new Promise<void>((resolve, reject) => {
        output.once("close", resolve);
        output.once("error", reject);
      });
    }

    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error("Export archive was not written correctly");
    }

    return { ...result, bytesWritten: stat.size, filePath };
  } catch (error) {
    output.destroy();
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function releaseTemporaryExportArchive(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== "ENOENT") {
      logger.warn(`[ExportArchive] Failed to release temporary archive ${filePath}:`, { error: error });
    }
  }
}

export async function streamTemporaryExportArchive(
  res: Response,
  filePath: string,
  downloadName: string
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT")
      throw new Error("Export archive has expired or was already downloaded", { cause: error });
    throw error;
  }

  if (!stat.isFile() || stat.size <= 0) throw new Error("Export archive is unavailable");

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${downloadName.replace(/[\r\n"]/g, "_")}"`);
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");

  await pipeline(fs.createReadStream(filePath), res);
}
