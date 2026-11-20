/**
 * The spreadsheet upload step of the factory product and bale Excel routes
 * (POST /api/factory/bale-products/import-excel, /api/factory/bales/validate-import,
 * /api/factory/bales/import-excel), run as middleware so validateRequest sees
 * the multipart form fields multer parsed. The size limit depends on the
 * session role, so multer is built per request. A missing file is left to the
 * handlers, which answer "No file uploaded".
 */
import { spreadsheetImportLimitBytes } from "@shared/fileSizePolicy";
import type { NextFunction, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";

export async function factoryProductSpreadsheetUpload(req: Request, res: Response, next: NextFunction) {
  const multer = (await import("multer")).default;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: spreadsheetImportLimitBytes(req.session?.currentRole), files: 1 },
  });
  upload.single("file")(req, res, (err: unknown) => {
    if (err) {
      const tooLarge = typeof err === "object" && err !== null && "code" in err && err.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        message: tooLarge ? "Excel file exceeds the 50 MB standard / 100 MB admin limit." : getErrorMessage(err),
      });
    }
    next();
  });
}
