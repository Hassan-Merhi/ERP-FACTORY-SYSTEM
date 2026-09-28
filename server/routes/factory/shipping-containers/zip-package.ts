/**
 * factoryShippingContainerRoutes: ShippingZipPackage endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { Writable } from "stream";
import { finished } from "stream/promises";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  customerOrders,
  customers,
  factoryShippingContainerRows,
  factoryShippingContainerDocuments,
} from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { ZipArchive } from "archiver";

import { fetchInternalBuffer, getCompanyId } from "./_helpers";

type ShippingZipEntry = { name: string; data: Buffer };

/**
 * Concatenate ZIP chunks without Buffer.concat(). The process-wide export
 * bridge intentionally replaces large application-owned Buffer.concat() calls
 * on ZIP/PDF download routes with zero-length deferred marker buffers. That is
 * correct for final HTTP delivery, but this route must inspect the completed
 * archive before it sets response headers, so a deferred marker looks like a
 * broken 0-byte ZIP. Copying into the final buffer directly keeps ZIP assembly
 * local and lets the response bridge handle only the finished response.
 */
function concatShippingZipChunks(chunks: Buffer[]): Buffer {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (totalLength === 0) return Buffer.alloc(0);

  const combined = Buffer.allocUnsafe(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    chunk.copy(combined, offset);
    offset += chunk.length;
  }
  return combined;
}

/**
 * Build the entire archive before touching the HTTP response.
 *
 * Use a write-only sink rather than a PassThrough/readable collector. The ZIP
 * bytes are captured in the Writable's write callback, which is the exact path
 * Archiver pipes through and cannot race readable-side flow/end events.
 */
export async function buildShippingZipBuffer(entries: ShippingZipEntry[]): Promise<Buffer> {
  if (entries.length === 0) {
    throw new Error("Download failed");
  }

  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });

  archive.on("warning", (warning) => {
    logger.warn("Warning while generating shipping ZIP package", { warning });
  });
  archive.on("error", (archiveError) => output.destroy(archiveError));
  archive.pipe(output);

  for (const entry of entries) {
    archive.append(entry.data, { name: entry.name });
  }

  const outputFinished = finished(output);
  const finalizePromise = archive.finalize();
  await Promise.all([finalizePromise, outputFinished]);

  const zipBuffer = concatShippingZipChunks(chunks);
  if (zipBuffer.length === 0) {
    logger.error("shipping_zip_zero_bytes", {
      entryCount: entries.length,
      archivePointer: archive.pointer(),
    });
    throw new Error("Download failed");
  }

  return zipBuffer;
}

export function registerShippingZipPackageRoutes(app: Express) {
  // ── GET download ZIP package ──────────────────────────────────────────────────
  app.get("/api/factory/shipping-container-rows/:id/zip-package", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const fileIds: string[] = ((req.query.fileIds as string) || "")
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (fileIds.length === 0) return res.status(400).json({ message: "No files selected" });

      const [row] = await db
        .select({
          id: factoryShippingContainerRows.id,
          customerOrderId: factoryShippingContainerRows.customerOrderId,
          invoiceNumber: customerOrders.invoiceNumber,
          customerId: customerOrders.customerId,
          clientName: customers.legalName,
          containerNumber: customerOrders.containerNumber,
          destination: customerOrders.destination,
        })
        .from(factoryShippingContainerRows)
        .innerJoin(customerOrders, eq(factoryShippingContainerRows.customerOrderId, customerOrders.id))
        .leftJoin(customers, eq(customerOrders.customerId, customers.id))
        .where(and(eq(factoryShippingContainerRows.id, id), eq(factoryShippingContainerRows.companyId, companyId)));
      if (!row) return res.status(404).json({ message: "Row not found" });

      function safeFilePart(s: string | null | undefined): string {
        return (s || "")
          .replace(/[^\x20-\x7E]/g, "") // strip non-ASCII (prevents ERR_INVALID_CHAR in headers)
          .replace(/"/g, "")
          .replace(/[\\/*?:[\]<>|]/g, "")
          .replace(/\s+/g, "_")
          .trim();
      }

      function safeZipEntryName(name: string | null | undefined, fallback: string): string {
        const leaf = (name || "")
          .split(/[\\/]/)
          .pop()
          ?.replace(/[\r\n]/g, "")
          .trim();
        return leaf || fallback;
      }

      function buildZipFilename(parts: (string | null | undefined)[], ext: string): string {
        const joined = parts.map(safeFilePart).filter(Boolean).join("_") || "export";
        return ext ? `${joined}.${ext}` : joined;
      }

      const zipFilename = buildZipFilename([row.containerNumber, row.clientName, row.destination], "zip");

      const docIdNumbers = fileIds
        .filter((f) => f.startsWith("doc_"))
        .map((f) => parseInt(f.slice(4)))
        .filter((n) => !isNaN(n));

      // Resolve every selected source before creating the archive. This keeps the
      // HTTP response clean if a generated export or uploaded document is broken.
      const [excelBuf, pdfBuf, docs] = await Promise.all([
        fileIds.includes("invoice_excel")
          ? fetchInternalBuffer(req, `/api/factory/customer-orders/${row.customerOrderId}/export-excel`)
          : Promise.resolve(null),
        fileIds.includes("statement_pdf") && row.customerId
          ? fetchInternalBuffer(req, `/api/factory/customers/${row.customerId}/statement/export-pdf`)
          : Promise.resolve(null),
        docIdNumbers.length > 0
          ? db
              .select({
                id: factoryShippingContainerDocuments.id,
                fileName: factoryShippingContainerDocuments.fileName,
                originalName: factoryShippingContainerDocuments.originalName,
                displayName: factoryShippingContainerDocuments.displayName,
                fileData: factoryShippingContainerDocuments.fileData,
              })
              .from(factoryShippingContainerDocuments)
              .where(
                and(
                  inArray(factoryShippingContainerDocuments.id, docIdNumbers),
                  eq(factoryShippingContainerDocuments.scrId, id),
                  eq(factoryShippingContainerDocuments.companyId, companyId)
                )
              )
          : Promise.resolve(
              [] as Array<{
                id: number;
                fileName: string | null;
                originalName: string | null;
                displayName: string | null;
                fileData: string | null;
              }>
            ),
      ]);

      const missingFiles: string[] = [];
      const entries: ShippingZipEntry[] = [];

      if (fileIds.includes("invoice_excel")) {
        if (excelBuf && excelBuf.length > 0) {
          entries.push({
            name: buildZipFilename([row.containerNumber, row.clientName, row.destination], "xlsx"),
            data: excelBuf,
          });
        } else {
          missingFiles.push("Commercial Invoice");
        }
      }

      if (fileIds.includes("statement_pdf")) {
        if (pdfBuf && pdfBuf.length > 0) {
          const safeClient = (row.clientName || "client").replace(/[^\w-]/g, "_");
          entries.push({ name: `Customer_Statement_${safeClient}.pdf`, data: pdfBuf });
        } else {
          missingFiles.push("Customer Statement");
        }
      }

      const docsById = new Map(docs.map((doc) => [doc.id, doc]));
      for (const docId of docIdNumbers) {
        const doc = docsById.get(docId);
        if (!doc) {
          missingFiles.push(`Uploaded document ${docId}`);
          continue;
        }

        const entryName = safeZipEntryName(
          doc.originalName?.trim() || doc.displayName?.trim() || doc.fileName?.trim(),
          `document_${doc.id}`
        );

        let fileBuffer: Buffer | null = null;
        if (doc.fileData?.trim()) {
          const decoded = Buffer.from(doc.fileData, "base64");
          if (decoded.length > 0) fileBuffer = decoded;
        }

        // Disk is only a cache in production, but keeping this fallback lets
        // older rows still download if their cache happens to be present.
        if (!fileBuffer && doc.fileName?.trim()) {
          const diskPath = path.join(process.cwd(), "uploads", "shipping-container-docs", doc.fileName);
          if (fs.existsSync(diskPath)) {
            const diskBuffer = fs.readFileSync(diskPath);
            if (diskBuffer.length > 0) fileBuffer = diskBuffer;
          }
        }

        if (!fileBuffer) {
          missingFiles.push(entryName);
          continue;
        }

        entries.push({ name: entryName, data: fileBuffer });
      }

      if (missingFiles.length > 0) {
        return res.status(409).json({
          message: `Selected files are unavailable or empty: ${missingFiles.join(", ")}. Re-upload any broken documents and try again.`,
        });
      }
      if (entries.length === 0) {
        return res.status(409).json({ message: "No selected files contained downloadable data." });
      }

      const zipBuffer = await buildShippingZipBuffer(entries);

      // Only send response after the ZIP is fully built — clean, no partial writes.
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${zipFilename}"`);
      res.setHeader("Content-Length", zipBuffer.length);
      res.end(zipBuffer);
    } catch (error: unknown) {
      logger.error("Error generating ZIP package:", { error: error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
