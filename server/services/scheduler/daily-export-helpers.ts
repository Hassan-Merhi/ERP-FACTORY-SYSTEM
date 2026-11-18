// Extracted from ./daily-export.ts
import { getErrorMessage } from "../../lib/httpHandlers";
import { ZipArchive } from "archiver";
import { logger } from "../../lib/logger";
import { generateNetPositionExcel } from "../../helpers/generateNetPositionExcel";

export const WHATSAPP_ATTACHMENT_LIMIT_MB = 15;

export function getTodayLabel(): string {
  return new Date().toISOString().substring(0, 10);
}

/**
 * Build a ZIP containing per-company net position Excel files.
 * A company whose workbook fails is logged and left out of the archive.
 */
export async function buildNetPositionZip(
  companies: Array<{ id: number; name: string }>,
  startDate: string,
  endDate: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const arc = new ZipArchive({ zlib: { level: 6 } });
    arc.on("data", (chunk: Buffer) => chunks.push(chunk));
    arc.on("end", () => resolve(Buffer.concat(chunks)));
    arc.on("error", reject);

    void (async () => {
      for (const company of companies) {
        const safe = company.name.replace(/[^a-z0-9]/gi, "_");
        try {
          // Render to a buffer first: appending a stream that later fails would
          // error the whole archive and leave it unfinalized.
          const workbook = await generateNetPositionExcel(company.id, company.name, startDate, endDate);
          arc.append(workbook, { name: `NetPosition_${safe}_${endDate}.xlsx` });
          logger.info(`[NetPositionExport] Added ${company.name}`);
        } catch (e: unknown) {
          logger.error(`[NetPositionExport] Failed for ${company.name}:`, { error: getErrorMessage(e) });
        }
      }

      await arc.finalize();
    })().catch(reject);
  });
}
