/**
 * The spreadsheet upload step of the bale reimport and bulk-rename routes
 * (./registerBalesReimportRoutesPart1.ts, ./balesReimportRoutes.ts), run as
 * middleware so validateRequest sees the multipart form fields multer parsed.
 * The size limit depends on the session role, so multer is built per request.
 * A missing file is left to the handlers, which answer "No file uploaded".
 */
import { spreadsheetImportLimitBytes } from "@shared/fileSizePolicy";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { emptyQuery, type RequestSchemas } from "../../../lib/validateRequest";

export async function spreadsheetUpload(req: Request, res: Response, next: NextFunction) {
  const multer = (await import("multer")).default;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: spreadsheetImportLimitBytes(req.session?.currentRole), files: 1 },
  });
  upload.single("file")(req, res, (err: unknown) => {
    if (err) {
      const tooLarge = typeof err === "object" && err !== null && "code" in err && err.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        code: tooLarge ? "UPLOAD_FILE_TOO_LARGE" : "UPLOAD_ERROR",
        message: tooLarge ? "Excel file exceeds the 50 MB standard / 100 MB admin limit." : "File upload error",
      });
    }
    next();
  });
}

// The screens post only the file. A request that is not multipart reaches the
// validator with no body; the handler then answers "No file uploaded".
/** POST /api/factory/bales/reimport: the daybook date is an optional form field. */
export const reimportInput = {
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ txDate: z.string().optional() })]),
} satisfies RequestSchemas;

/** POST /api/factory/bales/bulk-update-names: no form fields. */
export const bulkUpdateNamesInput = {
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({})]),
} satisfies RequestSchemas;
